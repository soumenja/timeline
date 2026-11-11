// Minimal GitHub "contents" API client: read and write one file in the repo.
import { utf8ToB64, b64ToUtf8 } from './crypto.js';

const API = 'https://api.github.com';
export const DATA_PATH = 'data/timeline.enc.json';

export class GitHubStore {
  constructor({ owner, repo, branch = 'main', token }) {
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
    this.token = token;
    this.sha = null;
  }

  get ready() { return !!(this.owner && this.repo && this.token); }

  headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  url(path) {
    const p = path.split('/').map(encodeURIComponent).join('/');
    return `${API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${p}`;
  }

  async check() {
    const res = await fetch(`${API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`,
      { headers: this.headers(), cache: 'no-store' });
    if (res.status === 401) throw new Error('GitHub rejected the token (expired or mistyped).');
    if (res.status === 404) throw new Error('Repository not found, or the token has no access to it.');
    if (!res.ok) throw new Error(`GitHub error ${res.status}.`);
    const info = await res.json();
    if (info.permissions && !info.permissions.push) {
      throw new Error('The token can read but not write. Give it "Contents: Read and write".');
    }
    return info;
  }

  /** Returns the parsed JSON file, or null if it does not exist yet. */
  async read(path = DATA_PATH) {
    const res = await fetch(`${this.url(path)}?ref=${encodeURIComponent(this.branch)}`,
      { headers: this.headers(), cache: 'no-store' });
    if (res.status === 404) { this.sha = null; return null; }
    if (!res.ok) throw new Error(`Could not read from GitHub (${res.status}).`);
    const file = await res.json();
    this.sha = file.sha;
    let text;
    if (file.content) {
      text = b64ToUtf8(file.content);
    } else {
      // Files over 1 MB come without inline content; fetch the raw blob instead.
      const raw = await fetch(file.git_url, { headers: { ...this.headers(), Accept: 'application/vnd.github.raw' } });
      text = await raw.text();
    }
    return JSON.parse(text);
  }

  async write(value, message, path = DATA_PATH) {
    const put = () => fetch(this.url(path), {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        branch: this.branch,
        content: utf8ToB64(JSON.stringify(value, null, 1) + '\n'),
        ...(this.sha ? { sha: this.sha } : {}),
      }),
    });

    if (this.sha === null) await this.refreshSha(path);
    let res = await put();
    if (res.status === 409 || res.status === 422) {
      // Our copy of the file version is stale; fetch the latest version id and retry once.
      await this.refreshSha(path);
      res = await put();
    }
    if (res.status === 401) throw new Error('GitHub rejected the token. Open GitHub connection and paste a new one.');
    if (res.status === 403 || res.status === 404) throw new Error('The token is not allowed to write to this repository.');
    if (!res.ok) throw new Error(`Save failed (GitHub error ${res.status}).`);
    const out = await res.json();
    this.sha = out.content.sha;
  }

  async refreshSha(path) {
    const res = await fetch(`${this.url(path)}?ref=${encodeURIComponent(this.branch)}`,
      { headers: this.headers(), cache: 'no-store' });
    this.sha = res.ok ? (await res.json()).sha : null;
  }
}

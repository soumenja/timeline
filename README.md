# My Timeline

A personal, zoomable timeline website hosted free on GitHub Pages.
Events are **encrypted with your passphrase** in the browser before they are saved, so the public site
shows only a lock screen to anyone without the passphrase.

## One-time setup (GitHub Desktop)

### 1. Put this folder on GitHub
1. Open **GitHub Desktop** → **File → Add local repository…** → choose this folder
   (`C:\Users\User1\Documents\Timeline_website`).
2. It says "This directory does not appear to be a Git repository". Click **create a repository**.
   - Name: `timeline` (or any name you like)
   - Leave **Git ignore** as *None* (this folder already has a `.gitignore`)
   - Click **Create repository**.
3. Check the **Changes** list. You should see `index.html`, `css/`, `js/`, `README.md`, `.gitignore` and `.nojekyll`.
   **`private/` must NOT be listed.** It holds your unencrypted events.
4. Click **Publish repository**. **Untick "Keep this code private"**: free GitHub Pages needs a public repo.
   Your events are still safe because they're encrypted.

### 2. Turn on the website
1. On github.com, open the repo → **Settings → Pages**.
2. Under *Build and deployment*: Source **Deploy from a branch**, Branch **main**, folder **/ (root)** → **Save**.
3. After 1–2 minutes the site is live at `https://<your-username>.github.io/timeline/`.

### 3. Create a token so the site can save
1. github.com → your avatar → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Repository access: **Only select repositories** → `timeline`.
3. Repository permissions → **Contents: Read and write**. Nothing else.
4. Generate it and copy it. Never share it or put it in any file.

### 4. Load your events
1. Open your site. It shows **Create your timeline**.
2. Choose a strong passphrase (and write it down somewhere safe: it **cannot be recovered**).
3. Under *Start from a JSON file*, pick `private\pil-timeline.json` → **Create timeline**.
4. Menu **⋯ → GitHub connection…**: your username and repo name, branch `main`, paste the token → **Test & save**.
5. Click **Save**. This writes `data/timeline.enc.json` (encrypted) to your repo.

From now on, opening the site asks for your passphrase.

## Using it
- Drag to move · scroll / pinch to zoom · double-click empty space to add an event · click an event to edit it.
- **Save** (or Ctrl+S) commits your changes to GitHub. The public site updates about a minute later.
- **⋯ → Download backup** saves an unencrypted copy. Keep it private and don't add it to the repo.
- On another device: open the site, enter the passphrase. To edit there too, add the token once via ⋯ → GitHub connection.

## Updating the site's code later
The site's Save button commits `data/timeline.enc.json` directly on GitHub. Before you push code changes from
GitHub Desktop, click **Fetch origin → Pull** first so you don't overwrite a newer saved timeline.

## Files
| Path | What |
|---|---|
| `index.html` | Page layout and dialogs |
| `css/style.css` | Styles |
| `js/timeline.js` | Drawing, zooming, dragging, event layout, overview strip |
| `js/app.js` | Lock screen, editor, list, save/load |
| `js/crypto.js` | AES-256-GCM encryption with a PBKDF2 passphrase key |
| `js/github.js` | Reads/writes the data file through the GitHub API |
| `data/timeline.enc.json` | Your encrypted events (created by the first Save) |
| `private/` | Unencrypted import file. Ignored by git, never uploaded |

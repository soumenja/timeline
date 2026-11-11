// Passphrase-based encryption for the timeline file (AES-256-GCM, key from PBKDF2-SHA256).
// Everything happens in the browser; only the encrypted result is ever sent to GitHub.

const enc = new TextEncoder();
const dec = new TextDecoder();
const ITERATIONS = 600000;

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function isEncryptedPayload(obj) {
  return !!obj && obj.format === 'timeline-enc' && typeof obj.data === 'string';
}

export async function encryptJSON(value, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const plain = enc.encode(JSON.stringify(value));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  return {
    format: 'timeline-enc',
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: ITERATIONS,
    salt: toB64(salt),
    iv: toB64(iv),
    data: toB64(cipher),
  };
}

export async function decryptJSON(payload, passphrase) {
  if (!isEncryptedPayload(payload)) throw new Error('Not an encrypted timeline file.');
  const key = await deriveKey(passphrase, fromB64(payload.salt), payload.iterations || ITERATIONS);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(payload.iv) }, key, fromB64(payload.data));
  } catch {
    throw new Error('Wrong passphrase.');
  }
  return JSON.parse(dec.decode(plain));
}

// UTF-8 safe base64 helpers used by the GitHub API module.
export function utf8ToB64(text) { return toB64(enc.encode(text)); }
export function b64ToUtf8(b64) { return dec.decode(fromB64(b64.replace(/\s/g, ''))); }

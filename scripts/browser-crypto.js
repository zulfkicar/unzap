// Build-only compatibility layer. The production runtime uses node:crypto.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
export function createHash(algorithm) {
  if (algorithm !== 'sha256') throw Error('Unsupported digest');
  const hash = sha256.create();
  return {
    update(value) { hash.update(typeof value === 'string' ? new TextEncoder().encode(value) : value); return this; },
    digest(encoding) { const bytes = hash.digest(); if (encoding !== 'hex') throw Error('Only hex digests are used by the browser compiler'); return bytesToHex(bytes); },
  };
}
export const randomUUID = () => crypto.randomUUID();
export function randomBytes(size) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return { toString(encoding) { if (encoding !== 'hex') throw Error('Unsupported encoding'); return bytesToHex(bytes); } };
}

/**
 * Vite alias target for `node:crypto`. Provides the sync `createHash` the
 * shared code expects (grandma-kat's definitionId, tree-versions' snapshot
 * hash) via the shared pure SHA-256, plus WebCrypto UUID/random bytes.
 */
import { sha256hex } from "../../../src/platform/sha256";

interface Hash {
  update(chunk: string | Uint8Array): Hash;
  digest(encoding?: string): string;
}

export function createHash(_algorithm: string): Hash {
  let data = "";
  return {
    update(chunk) {
      data += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return this;
    },
    digest() {
      return sha256hex(data);
    },
  };
}

export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

export function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export default { createHash, randomUUID, randomBytes };

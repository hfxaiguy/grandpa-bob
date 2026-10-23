/**
 * Per-browser device identity for BobSwap pairings.
 *
 * The pairing protocol identifies the two sides by their ECDSA P-256 public
 * keys and shows both humans a short visual check derived from them, so a
 * mistyped/guessed pairing code cannot silently connect the wrong device. The
 * same identity is what an ownership-swap grant will be signed with later.
 *
 * The key pair is generated once per browser profile and kept in localStorage
 * (never in the workspace, so exports/seeds never carry it).
 */
const STORE = "bob:device";

const b64encode = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource),
  );
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface DeviceIdentity {
  /** Human label shown to the peer ("desktop", "phone", or a custom name). */
  name: string;
  /** SPKI, base64 — the format the BobSwap service expects. */
  publicKeyB64: string;
  /** First 16 hex of sha256(SPKI DER). */
  deviceId: string;
  /** Private key as JWK, for the ownership handshake (unused in copy mode). */
  privateKeyJwk: JsonWebKey;
}

interface StoredDevice {
  name?: string;
  publicKeyB64?: string;
  deviceId?: string;
  privateKeyJwk?: JsonWebKey;
}

/** `desktop` / `phone` guess for the first-run label. */
export function detectDeviceName(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return /Mobi|Android|iPhone|iPad|iPod/i.test(ua) ? "phone" : "desktop";
}

function readStore(): StoredDevice {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as StoredDevice) : {};
  } catch {
    return {};
  }
}

function writeStore(value: StoredDevice): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(value));
  } catch {
    /* private mode: identity lasts for this boot only */
  }
}

/** Load the device identity, generating the key pair on first use. */
export async function loadOrCreateDevice(): Promise<DeviceIdentity> {
  const stored = readStore();
  if (stored.publicKeyB64 && stored.deviceId && stored.privateKeyJwk) {
    return {
      name: stored.name || detectDeviceName(),
      publicKeyB64: stored.publicKeyB64,
      deviceId: stored.deviceId,
      privateKeyJwk: stored.privateKeyJwk,
    };
  }

  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const publicKeyB64 = b64encode(spki);
  const deviceId = (await sha256HexBytes(spki)).slice(0, 16);
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const name = stored.name || detectDeviceName();
  writeStore({ name, publicKeyB64, deviceId, privateKeyJwk });
  return { name, publicKeyB64, deviceId, privateKeyJwk };
}

/** Rename this device (shown to the other side during pairing). */
export function saveDeviceName(name: string): void {
  const value = name.trim().slice(0, 40);
  if (!value) return;
  writeStore({ ...readStore(), name: value });
}

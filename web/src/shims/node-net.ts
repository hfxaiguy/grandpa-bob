/**
 * Vite alias target and module-loader builtin for `node:net`.
 *
 * The browser has no raw TCP. Importing this module is fine — a workspace tree
 * that merely pulls in an SMTP client (app/email does) must still load, so its
 * profile/auth/read paths keep working. Actually opening a socket throws with
 * the fix: SMTP is a Node/desktop capability, not a tab capability.
 */
export const NET_UNAVAILABLE =
  "node:net is not available in the browser: raw TCP (SMTP, IMAP) needs the " +
  "desktop/server target. Open this profile with the desktop app, or route the " +
  "send through an HTTP provider.";

export class Socket {
  constructor() {
    throw new Error(NET_UNAVAILABLE);
  }
}

export function createConnection(): never {
  throw new Error(NET_UNAVAILABLE);
}

export function connect(): never {
  throw new Error(NET_UNAVAILABLE);
}

export function createServer(): never {
  throw new Error(NET_UNAVAILABLE);
}

/** Enough address-shape knowledge for a client's TLS `servername` decision. */
export function isIP(value: string): number {
  const text = String(value ?? "").trim();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return 4;
  if (/^[0-9a-f:]+$/i.test(text) && text.includes(":")) return 6;
  return 0;
}

export function isIPv4(value: string): boolean {
  return isIP(value) === 4;
}

export function isIPv6(value: string): boolean {
  return isIP(value) === 6;
}

export default { Socket, createConnection, connect, createServer, isIP, isIPv4, isIPv6 };

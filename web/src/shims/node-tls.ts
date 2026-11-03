/**
 * Vite alias target and module-loader builtin for `node:tls`.
 *
 * Same contract as `node:net`: the import must resolve so a tree that bundles
 * an SMTP client can load, but starting a TLS socket throws with the fix.
 */
import { NET_UNAVAILABLE } from "./node-net";

export const TLS_UNAVAILABLE =
  "node:tls is not available in the browser: TLS sockets (SMTP, IMAPS) need the " +
  "desktop/server target. Open this profile with the desktop app, or route the " +
  "send through an HTTP provider.";

export class TLSSocket {
  constructor() {
    throw new Error(TLS_UNAVAILABLE);
  }
}

export function connect(): never {
  throw new Error(TLS_UNAVAILABLE);
}

export function createServer(): never {
  throw new Error(TLS_UNAVAILABLE);
}

export default { TLSSocket, connect, createServer, NET_UNAVAILABLE };

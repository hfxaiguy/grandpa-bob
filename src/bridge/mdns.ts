/**
 * mDNS-safe ICE candidate rewriting for the desktop mailbox.
 *
 * Firefox (and headless Gecko generally) hides host candidates behind mDNS:
 * `candidate:… <uuid>.local <port> typ host`. If the browser's mDNS responder
 * is not running, werift cannot resolve the name and ICE fails even though both
 * ends are on the same machine.
 *
 * The desktop mailbox is loopback-only, so both ends share the host. Replace
 * every `.local` candidate address with the bridge machine's local addresses,
 * keeping the browser's real port. One of the resulting candidates reaches the
 * browser's ICE socket; no browser pref or mDNS responder is required.
 */
import { networkInterfaces } from "node:os";

/** IPv4 addresses the answerer can use for a same-host browser's candidates. */
export function localMdnsHosts(): string[] {
  const hosts = new Set<string>(["127.0.0.1"]);
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal || addr.address.startsWith("169.254.")) continue;
      hosts.add(addr.address);
    }
  }
  return [...hosts];
}

/** Expand one browser candidate into one candidate per local host. */
export function expandLocalCandidate<T>(candidate: T, hosts: readonly string[]): T[] {
  const value = candidate as { candidate?: unknown } | null;
  const text = typeof value?.candidate === "string" ? value.candidate : "";
  if (!/\.local(?:\s|$)/i.test(text)) return [candidate];
  const tokens = text.split(" ");
  // candidate:<foundation> <component> <transport> <priority> <address> <port> …
  if (tokens.length < 6 || !/\.local$/i.test(tokens[4] ?? "")) return [candidate];
  return hosts.map((host) => {
    const next = tokens.slice();
    next[4] = host;
    return { ...(value as Record<string, unknown>), candidate: next.join(" ") } as T;
  });
}

/** Expand `.local` candidate lines inside an SDP offer. */
export function expandLocalSdp(sdp: string, hosts: readonly string[]): string {
  return sdp.replace(/(^|\r?\n)a=candidate:([^\r\n]+)/g, (line, prefix: string, body: string) => {
    if (!/\.local(?:\s|$)/i.test(body)) return line;
    const tokens = body.split(" ");
    // foundation component transport priority address port …
    if (tokens.length < 6 || !/\.local$/i.test(tokens[4] ?? "")) return line;
    return hosts
      .map((host) => {
        const next = tokens.slice();
        next[4] = host;
        return `${prefix}a=candidate:${next.join(" ")}`;
      })
      .join("");
  });
}

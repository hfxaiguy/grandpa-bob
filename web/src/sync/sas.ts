/**
 * Short authentication string (SAS) derived from both SDPs' DTLS certificate
 * fingerprints. Kept dependency-free so the Node bridge peer can use the exact
 * same derivation as the browser.
 */

/** Every `a=fingerprint:` value in an SDP, normalized so both sides agree. */
function fingerprints(sdp: string): string[] {
  return sdp
    .split(/\r?\n/)
    .filter((line) => line.startsWith("a=fingerprint:"))
    .map((line) => line.slice("a=fingerprint:".length).trim().toUpperCase())
    .filter((value) => value.length > 0);
}

/** The 6-word SAS for a pair of SDPs (order-independent, deduped). */
export function pairingPhrase(localSdp: string, remoteSdp: string): string {
  const seed = [...new Set([...fingerprints(localSdp), ...fingerprints(remoteSdp)])].sort().join("|");
  const words = ["anchor", "basil", "cedar", "delta", "ember", "fjord", "granite", "harbor", "igloo", "jasper"];
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const out: string[] = [];
  for (let i = 0; i < 6; i++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    out.push(words[Math.abs(h) % words.length]);
  }
  return out.join("-");
}

/** The SAS for an open connection (both sides compute the same phrase). */
export function verifyPhrase(pc: { localDescription?: { sdp?: string } | null; remoteDescription?: { sdp?: string } | null }): string {
  return pairingPhrase(pc.localDescription?.sdp ?? "", pc.remoteDescription?.sdp ?? "");
}

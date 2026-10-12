/** Thin wrappers over the admin API. Host-agnostic: in the browser target the
 *  fetch/EventSource shim routes these to the in-tab backend. */

export async function getJSON<T = unknown>(path: string): Promise<T> {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return (await r.json()) as T;
}

export interface ApiError extends Error {
  status?: number;
  data?: unknown;
}

export async function postJSON<T = unknown>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const d = (await r.json().catch(() => ({}))) as { error?: string } & T;
  if (!r.ok) {
    const err = new Error(d?.error || `${path}: ${r.status}`) as ApiError;
    err.status = r.status;
    err.data = d;
    throw err;
  }
  return d;
}

export function openEventStream(onMsg: (msg: any) => void, onState?: (connected: boolean) => void): EventSource {
  const es = new EventSource("/api/events");
  es.onopen = () => onState?.(true);
  es.onerror = () => onState?.(false);
  es.onmessage = (e) => {
    try {
      onMsg(JSON.parse(e.data));
    } catch {
      /* ignore keepalive / malformed frames */
    }
  };
  return es;
}

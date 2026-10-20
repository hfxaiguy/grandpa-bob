/** Copy/download the *full* event stream for the active session.
 *
 * The UI intentionally keeps only a tail in memory (500 events per turn) and
 * renders a shorter window. The turn log on disk is complete, so this fetches
 * `/api/turns` again and dumps what the API returns — every event of every
 * turn it exposes — ready to paste into a debug/agent session.
 *
 * Note: `/api/turns` exposes the latest MAX_TURNS (20) turns; the dump covers
 * those, with every event per turn. Older history stays in the run log.
 */
import { state, toast } from "./store";
import type { Turn } from "./types";

interface TurnsResponse {
  turns?: Turn[];
  session?: string | null;
  label?: string | null;
  awaiting?: string | null;
}

interface EventDump {
  source: "bob-web";
  copiedAt: string;
  session: string | null;
  label: string;
  turns: Turn[];
}

async function collect(): Promise<{ dump: EventDump; events: number }> {
  const res = await fetch("/api/turns", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`/api/turns failed: ${res.status}`);
  const data = (await res.json()) as TurnsResponse;
  const turns = Array.isArray(data.turns) ? data.turns : [];
  if (!turns.length) throw new Error("no turns in this session");
  const events = turns.reduce((n, turn) => n + (turn.events?.length ?? 0), 0);
  return {
    dump: {
      source: "bob-web",
      copiedAt: new Date().toISOString(),
      session: data.session ?? state.active,
      label: data.label ?? state.label,
      turns,
    },
    events,
  };
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* insecure context or denied permission */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function download(text: string, session: string | null): void {
  const id = String(session ?? "session").replace(/[^a-zA-Z0-9._-]+/g, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `bob-events-${id}-${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function copyEventStream(): Promise<void> {
  try {
    const { dump, events } = await collect();
    const text = JSON.stringify(dump);
    if (await copyText(text)) {
      toast(`copied ${events} events from ${dump.turns.length} turns`);
    } else {
      download(text, dump.session);
      toast("clipboard blocked — downloaded the event dump instead", true);
    }
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), true);
  }
}

export async function downloadEventStream(): Promise<void> {
  try {
    const { dump, events } = await collect();
    download(JSON.stringify(dump), dump.session);
    toast(`downloaded ${events} events from ${dump.turns.length} turns`);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), true);
  }
}

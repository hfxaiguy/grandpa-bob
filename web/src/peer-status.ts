/** Status shown for a profile's paired desktop/server. */
export type MirrorPhase = "unlinked" | "idle" | "syncing" | "offline" | "error";

export interface MirrorStatus {
  phase: MirrorPhase;
  detail: string;
  folder: string;
  lastSyncAt: string | null;
}

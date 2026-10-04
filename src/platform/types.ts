/**
 * Platform adapters. The shared core depends on the interfaces declared here;
 * each target injects a concrete implementation:
 *
 *   - Node target:    `src/platform/node.ts` (node:fs, node:sqlite, child_process, ...)
 *   - Browser target: `web/src/platform/browser.ts` (OPFS, sqlite-wasm, ...)
 *
 * This file intentionally declares only what the shared core needs, so the
 * browser adapter stays small.
 */
import type { PathOps } from "./paths.js";

export type { PathOps } from "./paths.js";

/** A file/dir entry from `FileSystem.readdir`. */
export interface DirEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** The subset of `fs/promises` the shared core uses. */
export interface FileSystem {
  readFile(path: string, encoding?: "utf8"): Promise<string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  mkdir(path: string, opts: { recursive: boolean }): Promise<void>;
  readdir(path: string, opts: { withFileTypes: true }): Promise<DirEntry[]>;
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>;
  rm(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/** Crypto primitives used by the shared core. */
export interface CryptoOps {
  randomUUID(): string;
  sha256hex(text: string): string;
}

/**
 * Command execution (Node: allowlisted execFile; browser: virtual coreutils).
 * Returns the already-formatted command output, matching the existing
 * `ShellTools.runCommand` contract.
 */
export interface Shell {
  runCommand(command: string, args: string[]): Promise<string>;
}

/** Git operations (Node/desktop: real git; browser: isomorphic-git over OPFS). */
export interface GitOps {
  ensureRepo(): Promise<void>;
  autoCommit(paths: string[], message: string): Promise<string>;
  status?(): Promise<unknown>;
  log?(depth?: number): Promise<unknown>;
  fetch?(url: string, branch?: string): Promise<unknown>;
  push?(url: string, branch?: string): Promise<unknown>;
  /** Fetch + fast-forward the working tree (a real "pull"). */
  pull?(url: string, branch?: string): Promise<unknown>;
  /** Stage every change (including deletions) and commit. */
  commitAll?(message: string): Promise<string>;
  /**
   * Atomically take a remote lock ref (`refs/bob/sync-lock`). True when held.
   * Only implemented where the git backend can create-if-absent (Node).
   */
  lockRef?(remote: string, owner: string, ttlMs: number): Promise<boolean>;
  unlockRef?(remote: string, owner: string): Promise<void>;
}

/** One column in a statement's result set. */
export interface SqliteColumn {
  name: string;
}

/**
 * A prepared statement. Async because the browser engine lives in a Web Worker
 * (OPFS sync access handles are worker-only); the Node adapter resolves
 * immediately.
 */
export interface SqliteStatement {
  all(...params: unknown[]): Promise<unknown[]>;
  get(...params: unknown[]): Promise<unknown>;
  run(...params: unknown[]): Promise<{ changes: number | bigint; lastInsertRowid: number | bigint }>;
  columns(): Promise<SqliteColumn[]>;
}

/** An open database. Async for the same reason as SqliteStatement. */
export interface SqliteDatabase {
  prepare(sql: string): Promise<SqliteStatement>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** Opens SQLite databases (Node: node:sqlite; browser: sqlite-wasm in a Worker). */
export interface SqliteFactory {
  open(path: string, opts: { readOnly: boolean }): Promise<SqliteDatabase>;
}

/** The bundle of adapters a target injects into the shared core. */
export interface Platform {
  readonly kind: "node" | "browser";
  readonly path: PathOps;
  readonly fs: FileSystem;
  readonly crypto: CryptoOps;
  readonly shell: Shell;
  readonly git: GitOps;
  readonly sqlite: SqliteFactory;
  /** Absolute-by-convention workspace root (Node: a real path; browser: e.g. "/workspace"). */
  readonly workspaceRoot: string;
}

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

/** Git operations (Node: git CLI; browser: isomorphic-git). */
export interface GitOps {
  ensureRepo(): Promise<void>;
  autoCommit(paths: string[], message: string): Promise<string>;
}

/** One column in a statement's result set. */
export interface SqliteColumn {
  name: string;
}

/** A prepared statement. Synchronous, matching node:sqlite's StatementSync. */
export interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  columns(): SqliteColumn[];
}

/** An open database. Synchronous, matching node:sqlite's DatabaseSync. */
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

/** Opens SQLite databases (Node: node:sqlite; browser: sqlite-wasm over OPFS). */
export interface SqliteFactory {
  open(path: string, opts: { readOnly: boolean }): SqliteDatabase;
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

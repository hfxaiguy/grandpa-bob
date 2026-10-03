// The `process` global installed by ./shims/process.ts, typed for shared
// modules that read process.pid / process.env at call time.
declare const process: {
  env: Record<string, string | undefined>;
  pid: number;
  platform: string;
  argv: string[];
  cwd(): string;
};

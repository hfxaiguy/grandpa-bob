// grandma-kat ships no type declarations; declare the surface the browser demo uses.
declare module "grandma-kat" {
  export type KnitResult = { result: unknown; memory: Record<string, unknown> };
  export function knit(pattern: unknown, runtime: unknown): Promise<KnitResult>;
  export function resume(continuation: string, runtime: unknown): Promise<KnitResult>;
  export function Tree(...args: unknown[]): unknown;
  export function From(...args: unknown[]): unknown;
  export function name(...args: unknown[]): unknown;
  export function Model(...args: unknown[]): unknown;
  export function Tools(...args: unknown[]): unknown;
  export function Needs(...args: unknown[]): unknown;
  export function Prompt(...args: unknown[]): unknown;
  export function Memory(...args: unknown[]): unknown;
  export function Register(...args: unknown[]): unknown;
  export function Branch(...args: unknown[]): unknown;
  export function Call(...args: unknown[]): unknown;
  export function Check(...args: unknown[]): unknown;
  export function Return(...args: unknown[]): unknown;
  export const grandma: { knit: typeof knit; resume: typeof resume };
  const _default: { knit: typeof knit; resume: typeof resume };
  export default _default;
}

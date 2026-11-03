/**
 * `withStopTools` — a thrown host/app tool error becomes a result.
 *
 * The browser host wraps its tool map so a tool failure reaches the engine as
 * `{ error }` (the same shape the auto-loop already uses) instead of escaping
 * as an exception. The explicit-loop path — `Prompt(disableAuto())` choosing a
 * tool, then `Call` running it — used to abort the whole tree on a rejection.
 *
 * This drives both halves: the wrapper's contracts (pass-through, error,
 * stop, pause/goto) and a real engine run where the model chooses a failing
 * tool. Without the wrapper the same tree rejects; with it the tree finishes
 * and the next step reads `{ error }`.
 *
 * No browser, no network. Run: npm run test:stop-tools.
 */
import assert from "node:assert/strict";
import { Call, Prompt, Return, Tools, Tree, disableAuto, knit, name } from "grandma-kat";
import { AgentStoppedError } from "../web/src/stop-error.ts";
import { isControlFlowSignal, withStopTools } from "../web/src/agent/stop-tools.ts";

type AnyTool = {
  description?: string;
  parameters?: Record<string, unknown>;
  execute: (...args: unknown[]) => unknown;
};

const signal = new AbortController().signal;
const okay: AnyTool = { execute: () => ({ value: 7 }) };
const explodes: AnyTool = {
  execute: () => {
    throw new Error("tool exploded");
  },
};
const wrapped = withStopTools({ okay, explodes }, signal) as Record<string, AnyTool>;

// ── wrapper contracts ───────────────────────────────────────────────────
assert.deepEqual(await wrapped.okay.execute({}), { value: 7 }, "a good result passes through");
assert.deepEqual(
  await wrapped.explodes.execute({}),
  { error: "tool exploded" },
  "a throw becomes the engine's { error } result",
);
assert.equal(wrapped.okay, wrapped.okay, "the wrapped tool is cached per name");

const stoppedSignal = new AbortController();
stoppedSignal.abort();
const stopped = withStopTools({ okay }, stoppedSignal.signal) as Record<string, AnyTool>;
await assert.rejects(() => stopped.okay.execute({}), AgentStoppedError, "a stop still rejects");

const pause = { checkpointId: "run:1" };
const goto = { target: "slot", value: "next" };
assert.equal(isControlFlowSignal(pause), true);
assert.equal(isControlFlowSignal(goto), true);
assert.equal(isControlFlowSignal(new Error("nope")), false);
for (const [label, thrown] of [
  ["pause", pause],
  ["goto", goto],
] as const) {
  const control = withStopTools(
    {
      wait: {
        execute: () => {
          throw thrown;
        },
      },
    },
    signal,
  ) as Record<string, AnyTool>;
  await assert.rejects(
    () => control.wait.execute({}),
    (err: unknown) => err === thrown,
    `${label} control flow propagates unchanged`,
  );
}

// ── real engine: disableAuto chooses the tool, Call runs it ─────────────
const models = {
  default: {
    model: "mock",
    handler: async () => ({
      content: "",
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "explodes", arguments: "{}" } },
      ],
    }),
  },
};

const pattern = Tree(
  name("stop-tools"),
  Tools("explodes"),
  Prompt("choose", () => "use the failing tool", disableAuto()),
  // The explicit loop: dispatch whatever the single-round model chose.
  Call(
    (m: any) => m.raw.prev[0].toolCalls[0].name,
    (m: any) => JSON.parse(m.raw.prev[0].toolCalls[0].arguments || "{}"),
  ),
  Return((m: any) => m.prev[0]),
);

const out = await knit(pattern, { models, tools: wrapped, logger: false });
assert.deepEqual(
  out.result,
  { error: "tool exploded" },
  "the explicit-loop Call folds the failure and the tree continues",
);

// Control: the same tree with the raw tools aborts, which is the old behavior.
await assert.rejects(
  () => knit(pattern, { models, tools: { explodes }, logger: false }),
  /tool exploded/,
  "without the wrapper, a thrown tool error still kills the tree",
);

console.log("stop-tools: wrapper contracts and explicit-loop recovery OK");

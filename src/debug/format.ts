import type { KatEvent } from "./event-logger.js";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const KIND_COLORS: Record<string, string> = {
  llm_call: C.cyan,
  tool_call: C.yellow,
  tool_result: C.green,
  check: C.magenta,
  gate: C.blue,
  flow: C.gray,
  skip: C.dim,
  human: C.bold,
  scope_init: C.dim,
  record: C.dim,
  emit: C.green,
  memory: C.blue,
};

const KIND_LABELS: Record<string, string> = {
  llm_call: "llm",
  tool_call: "tool",
  tool_result: "result",
  check: "check",
  gate: "gate",
  flow: "flow",
  skip: "skip",
  human: "human",
  scope_init: "scope",
  record: "record",
  emit: "emit",
  memory: "memory",
};

function truncate(s: unknown, max: number): string {
  if (s === null || s === undefined) return "";
  const str = String(s).replace(/\n/g, " ");
  return str.length > max ? str.slice(0, max) + "…" : str;
}

function formatContent(kind: string, c: Record<string, unknown>, path: string, iter: string): string[] {
  const lines: string[] = [];

  switch (kind) {
    case "llm_call": {
      const model = (c.model as string) ?? "?";
      const round = (c.round as number) > 1 ? ` round ${c.round}` : "";
      lines.push(`${C.cyan}  llm${C.reset}${path}${iter}: ${model}${round}`);
      if (Array.isArray(c.messages)) {
        lines.push(`${C.dim}    input (${(c.messages as unknown[]).length} messages):${C.reset}`);
        for (const m of c.messages as { role: string; content: unknown }[]) {
          const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          lines.push(`${C.dim}      [${m.role}] ${truncate(content, 150)}${C.reset}`);
        }
      }
      if (c.reasoning) lines.push(`${C.dim}    thinking: ${truncate(c.reasoning, 200)}${C.reset}`);
      if (c.content) lines.push(`    output: ${truncate(c.content, 200)}`);
      if (Array.isArray(c.toolCalls) && c.toolCalls.length > 0) {
        const calls = (c.toolCalls as Record<string, unknown>[])
          .map((t) => {
            const name = (t.name as string) ?? ((t.function as Record<string, unknown>)?.name as string) ?? "?";
            const args = (t.arguments as string) ?? ((t.function as Record<string, unknown>)?.arguments as string) ?? "";
            return `${name}(${truncate(args, 60)})`;
          })
          .join(", ");
        lines.push(`${C.yellow}    tool calls: ${calls}${C.reset}`);
      }
      break;
    }
    case "tool_call": {
      const tool = (c.tool as string) ?? (c.child as string) ?? "?";
      const args = c.args ? `(${truncate(JSON.stringify(c.args), 60)})` : "";
      lines.push(`${C.yellow}  tool${C.reset}${path}: ${tool}${args}`);
      break;
    }
    case "tool_result": {
      const tool = (c.tool as string) ?? "?";
      const args = c.args ? `(${truncate(JSON.stringify(c.args), 40)})` : "";
      const result = truncate(JSON.stringify(c.result), 80);
      lines.push(`${C.green}  result${C.reset}${path}: ${tool}${args} → ${result}`);
      break;
    }
    case "check": {
      const child = (c.child as string) ?? "?";
      const pass = c.pass ? `${C.green}pass${C.reset}` : `${C.red}FAIL: ${truncate(c.feedback, 60)}${C.reset}`;
      lines.push(`${C.magenta}  check${C.reset}${path}: ${child} ${pass}`);
      break;
    }
    case "gate": {
      const child = (c.child as string) ?? "?";
      const result = String(c.result ?? "?");
      lines.push(`${C.blue}  gate${C.reset}${path}: ${child} → ${result}`);
      break;
    }
    case "flow": {
      const type = String(c.type ?? "?");
      const goback = c.n ? ` goback(${c.n})` : "";
      const child = c.child ? ` from '${c.child}'` : "";
      const used = c.used ? ` (${c.used}/${c.max ?? "?"})` : "";
      lines.push(`${C.gray}  flow${C.reset}${path}: ${type}${goback}${child}${used}`);
      break;
    }
    case "memory": {
      const child = (c.child as string) ?? "?";
      const value = truncate(JSON.stringify(c.value), 60);
      lines.push(`${C.blue}  memory${C.reset}${path}: ${child} = ${value}`);
      break;
    }
    case "emit": {
      const value = typeof c.value === "string" ? c.value : JSON.stringify(c.value);
      lines.push(`${C.bold}  emit${C.reset}${path}: ${value}`);
      break;
    }
    case "human": {
      const child = (c.child as string) ?? "?";
      lines.push(`${C.bold}  human${C.reset}${path}: ${child} (paused)`);
      break;
    }
    case "skip": {
      lines.push(`${C.dim}  skip${C.reset}${path}: ${JSON.stringify(c)}`);
      break;
    }
    default: {
      lines.push(`${C.dim}  ${kind}${C.reset}${path}: ${JSON.stringify(c)}`);
    }
  }

  return lines;
}

/**
 * Format a KatEvent into ANSI-styled lines for terminal output.
 */
export function formatEvent(event: KatEvent): string[] {
  const c = event.content ?? {};
  const path = event.branch_path ? ` ${C.dim}[${event.branch_path}]${C.reset}` : "";
  const iter = event.iteration > 1 ? ` #${event.iteration}` : "";
  // Memory writes are record rows with an op flag; render them as memory.
  const memWrite = event.kind === "record" && (c.op === "memory" || c.op === "memoryUpdate");
  return formatContent(memWrite ? "memory" : event.kind, c, path, iter);
}

/**
 * Format the agent's emit output (the final answer shown to the user).
 */
export function formatAgentOutput(text: string): string[] {
  if (!text) return [];
  return [``, `${C.green}${C.bold}${text}${C.reset}`, ``];
}

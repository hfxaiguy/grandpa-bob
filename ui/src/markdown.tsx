/** Markdown rendering for the tiled UI.
 *
 *  Message text is untrusted (it comes from an LLM and from tool output), so
 *  this renders marked's token tree as Solid nodes instead of building an HTML
 *  string: every text leaf stays an escaped text node, `innerHTML` is never
 *  used, and raw HTML in a message is shown literally rather than parsed.
 *  Link/image targets are restricted to http(s)/mailto, so a `javascript:`
 *  payload cannot become a live link.
 *
 *  `ref://…` handles are split out of running text and handed to the caller,
 *  which keeps them clickable inside any markdown construct (bold, list items,
 *  table cells, …).
 */
import { For, createMemo } from "solid-js";
import type { JSX } from "solid-js";
import { marked, type Token, type Tokens } from "marked";

export interface MarkdownProps {
  text: string;
  /** Render inline markup only, without the wrapping `.md` block — for
   *  single-line surfaces such as an event-log row. Block syntax is flattened
   *  onto the one line. */
  inline?: boolean;
  /** Render one `ref://…` handle; when omitted the handle stays plain text. */
  renderRef?: (token: string) => JSX.Element;
}

const REF_TOKEN = /ref:\/\/[A-Za-z0-9_.\/-]+/g;
const SAFE_HREF = /^(?:https?:\/\/|mailto:)/i;

const safeHref = (href: string): boolean => SAFE_HREF.test(href);

/** Running text with any `ref://…` handles replaced by caller-rendered nodes.
 *  Sentence punctuation after a handle is not part of it (as before). */
function withRefs(text: string, renderRef?: (token: string) => JSX.Element): JSX.Element {
  if (!renderRef || !text.includes("ref://")) return text;
  const out: JSX.Element[] = [];
  let last = 0;
  for (const m of text.matchAll(REF_TOKEN)) {
    const i = m.index ?? 0;
    const raw = m[0];
    const link = raw.replace(/[.,;:!?\])}]+$/, "");
    const trail = raw.slice(link.length);
    if (i > last) out.push(text.slice(last, i));
    if (link) out.push(renderRef(link));
    if (trail) out.push(trail);
    last = i + raw.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Inline tokens as nodes. */
function inlineTokens(tokens: Token[] | undefined, p: MarkdownProps): JSX.Element {
  return <For each={tokens ?? []}>{(t) => inlineToken(t, p)}</For>;
}

function inlineToken(t: Token, p: MarkdownProps): JSX.Element {
  switch (t.type) {
    case "text": {
      const tx = t as Tokens.Text;
      return tx.tokens?.length ? inlineTokens(tx.tokens, p) : withRefs(tx.text, p.renderRef);
    }
    case "escape":
      return (t as Tokens.Escape).text;
    // Raw HTML is deliberately shown as text, never parsed as markup.
    case "html":
      return (t as Tokens.HTML).text;
    case "br":
      return <br />;
    case "strong":
      return <strong>{inlineTokens((t as Tokens.Strong).tokens, p)}</strong>;
    case "em":
      return <em>{inlineTokens((t as Tokens.Em).tokens, p)}</em>;
    case "del":
      return <del>{inlineTokens((t as Tokens.Del).tokens, p)}</del>;
    case "codespan":
      return <code class="md-code">{(t as Tokens.Codespan).text}</code>;
    case "link": {
      const l = t as Tokens.Link;
      // No ref buttons inside a link: a button nested in an anchor is invalid.
      const body = inlineTokens(l.tokens, { ...p, renderRef: undefined });
      return safeHref(l.href) ? (
        <a href={l.href} title={l.title ?? undefined} target="_blank" rel="noreferrer noopener">
          {body}
        </a>
      ) : (
        body
      );
    }
    case "image": {
      const im = t as Tokens.Image;
      // Remote images are linked, not fetched: the chat UI stays text-only.
      const label = im.text || im.href;
      return safeHref(im.href) ? (
        <a class="md-img" href={im.href} title={im.title ?? undefined} target="_blank" rel="noreferrer noopener">
          🖼 {label}
        </a>
      ) : (
        <span class="md-img">🖼 {label}</span>
      );
    }
    // The task marker is rendered from the list item itself.
    case "checkbox":
      return null;
    default: {
      const g = t as Tokens.Generic;
      if (g.tokens?.length) return inlineTokens(g.tokens, p);
      return typeof g.text === "string" ? withRefs(g.text, p.renderRef) : (g.raw ?? "");
    }
  }
}

/** Block tokens as nodes. */
function blockTokens(tokens: Token[] | undefined, p: MarkdownProps): JSX.Element {
  return <For each={tokens ?? []}>{(t) => blockToken(t, p)}</For>;
}

function listItem(item: Tokens.ListItem, p: MarkdownProps): JSX.Element {
  const body = blockTokens(
    item.tokens.filter((t) => t.type !== "checkbox"),
    p,
  );
  return (
    <li classList={{ "md-task": item.task }}>
      {item.task ? <input type="checkbox" disabled checked={!!item.checked} /> : null}
      {body}
    </li>
  );
}

function alignStyle(align: Tokens.TableCell["align"]): JSX.CSSProperties | undefined {
  return align ? { "text-align": align } : undefined;
}

function blockToken(t: Token, p: MarkdownProps): JSX.Element {
  switch (t.type) {
    case "space":
    case "def":
      return null;
    // A tight-list item carries its inline content in a block-level `text`.
    case "text": {
      const tx = t as Tokens.Text;
      return tx.tokens?.length ? inlineTokens(tx.tokens, p) : withRefs(tx.text, p.renderRef);
    }
    case "heading": {
      const h = t as Tokens.Heading;
      const body = inlineTokens(h.tokens, p);
      switch (Math.min(Math.max(h.depth, 1), 6)) {
        case 1: return <h1>{body}</h1>;
        case 2: return <h2>{body}</h2>;
        case 3: return <h3>{body}</h3>;
        case 4: return <h4>{body}</h4>;
        case 5: return <h5>{body}</h5>;
        default: return <h6>{body}</h6>;
      }
    }
    case "paragraph":
      return <p>{inlineTokens((t as Tokens.Paragraph).tokens, p)}</p>;
    case "code": {
      const c = t as Tokens.Code;
      return (
        <pre class="md-pre">
          <code class={c.lang ? `language-${c.lang}` : undefined}>{c.text}</code>
        </pre>
      );
    }
    case "blockquote":
      return <blockquote>{blockTokens((t as Tokens.Blockquote).tokens, p)}</blockquote>;
    case "hr":
      return <hr />;
    case "list": {
      const l = t as Tokens.List;
      const items = <For each={l.items}>{(item) => listItem(item, p)}</For>;
      return l.ordered ? (
        <ol start={typeof l.start === "number" && l.start !== 1 ? l.start : undefined}>{items}</ol>
      ) : (
        <ul>{items}</ul>
      );
    }
    case "list_item":
      return listItem(t as Tokens.ListItem, p);
    case "table": {
      const tb = t as Tokens.Table;
      return (
        <table class="md-table">
          <thead>
            <tr>
              <For each={tb.header}>
                {(cell) => <th style={alignStyle(cell.align)}>{inlineTokens(cell.tokens, p)}</th>}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={tb.rows}>
              {(row) => (
                <tr>
                  <For each={row}>
                    {(cell) => <td style={alignStyle(cell.align)}>{inlineTokens(cell.tokens, p)}</td>}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      );
    }
    case "html":
      return <div class="md-raw">{(t as Tokens.HTML).text}</div>;
    default: {
      const g = t as Tokens.Generic;
      if (g.tokens?.length) return blockTokens(g.tokens, p);
      return typeof g.text === "string" ? withRefs(g.text, p.renderRef) : (g.raw ?? "");
    }
  }
}

/** Block tokens flattened onto one line (inline mode): paragraphs and headings
 *  lose their wrappers, list items join with `·`, table rows with `|`. */
function flattenTokens(tokens: Token[] | undefined, p: MarkdownProps): JSX.Element {
  return <For each={tokens ?? []}>{(t) => flattenToken(t, p)}</For>;
}

function flattenToken(t: Token, p: MarkdownProps): JSX.Element {
  switch (t.type) {
    case "space":
    case "def":
      return null;
    case "paragraph":
    case "heading": {
      const g = t as Tokens.Paragraph | Tokens.Heading;
      return inlineTokens(g.tokens, p);
    }
    case "text": {
      const tx = t as Tokens.Text;
      return tx.tokens?.length ? inlineTokens(tx.tokens, p) : withRefs(tx.text, p.renderRef);
    }
    case "code":
      return <code class="md-code">{(t as Tokens.Code).text}</code>;
    case "br":
      return " ";
    case "hr":
      return " — ";
    case "blockquote":
      return flattenTokens((t as Tokens.Blockquote).tokens, p);
    case "list": {
      const parts: JSX.Element[] = [];
      (t as Tokens.List).items.forEach((item, i) => {
        if (i) parts.push(" · ");
        parts.push(
          flattenTokens(
            item.tokens.filter((x) => x.type !== "checkbox"),
            p,
          ),
        );
      });
      return parts;
    }
    case "table": {
      const tb = t as Tokens.Table;
      const parts: JSX.Element[] = [];
      const pushRow = (cells: Tokens.TableCell[]) => {
        if (parts.length) parts.push(" · ");
        cells.forEach((cell, ci) => {
          if (ci) parts.push(" | ");
          parts.push(inlineTokens(cell.tokens, p));
        });
      };
      pushRow(tb.header);
      for (const row of tb.rows) pushRow(row);
      return parts;
    }
    case "html":
      return (t as Tokens.HTML).text;
    default:
      return inlineToken(t, p);
  }
}

export function Markdown(props: MarkdownProps): JSX.Element {
  // The lexer is deterministic and cheap; keep it reactive so a surface whose
  // text changes in place re-renders.
  const tokens = createMemo(() => marked.lexer(String(props.text ?? ""), { gfm: true, breaks: true }));
  return props.inline ? (
    <For each={tokens()}>{(t) => flattenToken(t, props)}</For>
  ) : (
    <div class="md">
      <For each={tokens()}>{(t) => blockToken(t, props)}</For>
    </div>
  );
}

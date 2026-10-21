/**
 * A pure, zero-dependency delimited-file parser (RFC 4180) shared by both
 * targets — the same role paths.ts and sha256.ts play for other primitives.
 *
 * `csv_query` (src/tools/csv.ts) feeds a parsed file into SQLite as the `csv`
 * table; the parser deliberately knows nothing about SQL.
 *
 * Handles: quoted fields with `""` escapes, commas and newlines inside
 * quotes, `\r\n` / `\n` / lone `\r` line endings, a leading BOM, blank lines,
 * and a missing final newline. Values stay text unless they parse as a safe
 * number; an unquoted empty cell becomes null while a quoted `""` stays an
 * empty string, so the two are distinguishable the way the file wrote them.
 */

export interface ParsedCsv {
  /** Header names, BOM-stripped and deduplicated (`a`, `a` → `a`, `a_2`). */
  columns: string[];
  /** One array per data row, aligned with `columns` (missing cells are null). */
  records: unknown[][];
}

/** Numeric text becomes a JS number; leading zeros and huge integers stay text. */
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function coerce(raw: string, quoted: boolean): unknown {
  if (!raw) return quoted ? "" : null;
  if (NUMBER.test(raw)) {
    const n = Number(raw);
    // Keep identifiers (phone numbers, long ids) intact rather than rounding.
    if (Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) return n;
  }
  return raw;
}

/** Turn the first record into unique, non-empty column names. */
export function csvHeaders(first: Array<string | null>): string[] {
  const used = new Set<string>();
  const names: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const base = String(first[i] ?? "").replace(/^\uFEFF+/, "").trim() || `col${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    names.push(name);
  }
  return names;
}

/**
 * Parse a whole delimited file. `delimiter` is a single character ("," for
 * CSV, "\t" for TSV — the caller picks, normally from the file extension).
 */
export function parseCsv(text: string, { delimiter = "," } = {}): ParsedCsv {
  const sep = delimiter.length === 1 ? delimiter : ",";
  const body = text.replace(/^\uFEFF+/, "");

  const records: unknown[][] = [];
  let field = "";
  let row: unknown[] = [];
  let quoted = false;
  let anyQuoted = false;
  let fieldStart = true; // a field whose first char is `"` opens a quoted field

  const endField = (): void => {
    row.push(coerce(field, anyQuoted));
    field = "";
    anyQuoted = false;
    fieldStart = true;
  };
  const endRow = (): void => {
    endField();
    // A blank line is not a record (a quoted "" still is: anyQuoted was true).
    if (row.length === 1 && row[0] === null) {
      row = [];
      return;
    }
    records.push(row);
    row = [];
  };

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];

    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false; // closing quote; the next delimiter/newline ends the field
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (fieldStart && field === "" && ch === '"') {
      quoted = true;
      anyQuoted = true;
      fieldStart = false;
      continue;
    }
    fieldStart = false;

    if (ch === sep) {
      endField();
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && body[i + 1] === "\n") i++;
      endRow();
      continue;
    }
    field += ch;
  }
  // A final field/row when the file does not end with a newline.
  if (field !== "" || row.length > 0 || anyQuoted) endRow();

  if (records.length === 0) return { columns: [], records: [] };
  const columns = csvHeaders(records[0] as Array<string | null>);
  const width = columns.length;
  const data = records.slice(1).map((cells) => {
    const out = cells.slice(0, width);
    while (out.length < width) out.push(null);
    return out;
  });
  return { columns, records: data };
}

/** A double-quoted SQL identifier (embedded `"` doubled). */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** A SQL literal for a parsed cell: number as-is, null bare, text quoted. */
export function quoteValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

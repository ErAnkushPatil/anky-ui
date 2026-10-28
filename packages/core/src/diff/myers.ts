export type DiffSegment = { type: "equal" | "insert" | "delete"; value: string };

export type DiffMode = "word" | "char";

export interface DiffOptions {
  /**
   * Total work budget, counted in Myers steps (diagonal probes plus matched-token
   * comparisons). Bounds worst-case latency and memory. When the word-level pass
   * runs out, the differing middle is reported as one delete + insert. When
   * char-level refinement runs out, the remaining regions stay at word
   * granularity. Defaults to {@link DEFAULT_DIFF_MAX_COST}.
   */
  maxCost?: number;
}

/** Keeps the worst case (two unrelated 5,000-char strings) under ~2ms on commodity hardware. */
export const DEFAULT_DIFF_MAX_COST = 100_000;

const EQUAL = 0;
const INSERT = 1;
const DELETE = 2;
type OpCode = typeof EQUAL | typeof INSERT | typeof DELETE;

interface Budget {
  remaining: number;
}

/**
 * Compute a diff between two strings at word or character granularity.
 *
 * Both modes start with Myers' O(ND) algorithm over interned word tokens,
 * after trimming the common prefix and suffix.
 * - `'word'` tokens are runs of letters/digits/marks/underscore, runs of
 *   whitespace, or single punctuation characters.
 * - `'char'` additionally refines each changed region with a char-level Myers
 *   pass over Unicode code points (surrogate pairs are never split). Matching
 *   is anchored at unchanged words, so the work scales with the size of the
 *   edits rather than the size of the document, and the output avoids
 *   cross-word noise.
 *
 * Output invariants: no empty segments, no two consecutive segments of the same
 * type, and each change region is one `delete` followed by one `insert`.
 * Joining `equal` + `delete` values gives `oldText`; joining `equal` + `insert`
 * values gives `newText`.
 *
 * Pure function with no module-level state. Scratch buffers are released on return.
 */
export function computeDiff(
  oldText: string,
  newText: string,
  mode: DiffMode = "word",
  options: DiffOptions = {},
): DiffSegment[] {
  if (oldText === newText) return oldText ? [{ type: "equal", value: oldText }] : [];

  const budget: Budget = { remaining: Math.max(0, options.maxCost ?? DEFAULT_DIFF_MAX_COST) };
  const out = new SegmentBuilder(mode === "char" ? budget : null);

  const a = oldText.match(WORD_TOKEN) ?? [];
  const b = newText.match(WORD_TOKEN) ?? [];
  const table = new Map<string, number>();
  const aIds = internWords(a, table);
  const bIds = internWords(b, table);
  diffSequences(aIds, bIds, a, b, budget, out);
  return out.finish();
}

const WORD_TOKEN = /[\p{L}\p{N}\p{M}_]+|\s+|[^\p{L}\p{N}\p{M}_\s]/gu;

function internWords(tokens: string[], table: Map<string, number>): Int32Array {
  const ids = new Int32Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) {
    let id = table.get(tokens[i]);
    if (id === undefined) {
      id = table.size;
      table.set(tokens[i], id);
    }
    ids[i] = id;
  }
  return ids;
}

function codePoints(text: string): [string[], Int32Array] {
  const chars = Array.from(text);
  const ids = new Int32Array(chars.length);
  for (let i = 0; i < chars.length; i++) ids[i] = chars[i].codePointAt(0)!;
  return [chars, ids];
}

/**
 * Trim the common prefix/suffix, run Myers on the middle, and stream the result
 * into `out`. On budget overflow the middle becomes a single replace.
 */
function diffSequences(
  aIds: Int32Array,
  bIds: Int32Array,
  a: string[],
  b: string[],
  budget: Budget,
  out: SegmentBuilder,
): void {
  let start = 0;
  let endA = a.length;
  let endB = b.length;
  while (start < endA && start < endB && aIds[start] === bIds[start]) start++;
  while (endA > start && endB > start && aIds[endA - 1] === bIds[endB - 1]) {
    endA--;
    endB--;
  }

  for (let i = 0; i < start; i++) out.push(EQUAL, a[i]);

  const ops = myers(aIds, start, endA, bIds, start, endB, budget);
  if (ops) {
    let ai = start;
    let bi = start;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i] as OpCode;
      if (op === EQUAL) {
        out.push(EQUAL, a[ai++]);
        bi++;
      } else if (op === DELETE) out.push(DELETE, a[ai++]);
      else out.push(INSERT, b[bi++]);
    }
  } else {
    for (let i = start; i < endA; i++) out.push(DELETE, a[i]);
    for (let i = start; i < endB; i++) out.push(INSERT, b[i]);
  }

  for (let i = endA; i < a.length; i++) out.push(EQUAL, a[i]);
}

/**
 * Myers' greedy forward search returning opcodes in forward order, or `null`
 * when the budget runs out. Work is charged to `budget` either way.
 *
 * Every level d's furthest-reaching x per diagonal is written straight into one
 * flat buffer. Only same-parity diagonals are reachable, so level d takes d + 1
 * slots starting at d(d + 1) / 2, and diagonal k sits at slot (k + d) / 2.
 * Level d costs at least d + 1 work units, so the buffer is O(budget) in size.
 */
function myers(
  a: Int32Array,
  aStart: number,
  aEnd: number,
  b: Int32Array,
  bStart: number,
  bEnd: number,
  budget: Budget,
): Uint8Array | null {
  const n = aEnd - aStart;
  const m = bEnd - bStart;
  if (n === 0 || m === 0) {
    const ops = new Uint8Array(n + m);
    ops.fill(n === 0 ? INSERT : DELETE);
    return ops;
  }

  let trace = new Int32Array(256);
  let finalD = -1;
  let cost = 0;

  search: for (let d = 0; d <= n + m; d++) {
    const base = (d * (d + 1)) >>> 1;
    if (base + d + 1 > trace.length) {
      const grown = new Int32Array(Math.max(trace.length * 2, base + d + 1));
      grown.set(trace);
      trace = grown;
    }
    const prevBase = base - d;
    for (let k = -d, slot = 0; k <= d; k += 2, slot++) {
      let x: number;
      if (d === 0) x = 0;
      else if (k === -d) x = trace[prevBase + slot]; // from diagonal k + 1 (insertion)
      else if (k === d) x = trace[prevBase + slot - 1] + 1; // from diagonal k - 1 (deletion)
      else {
        const fromDel = trace[prevBase + slot - 1];
        const fromIns = trace[prevBase + slot];
        x = fromDel < fromIns ? fromIns : fromDel + 1;
      }
      let y = x - k;
      const snakeStart = x;
      while (x < n && y < m && a[aStart + x] === b[bStart + y]) {
        x++;
        y++;
      }
      cost += 1 + x - snakeStart;
      trace[base + slot] = x;
      if (x >= n && y >= m) {
        finalD = d;
        break search;
      }
    }
    if (cost > budget.remaining) {
      budget.remaining = 0;
      return null;
    }
  }
  budget.remaining -= cost;

  // Backtrack from (n, m) to (0, 0), filling opcodes from the end.
  // Script length = D edits + (n + m - D) / 2 equal tokens.
  const ops = new Uint8Array((n + m + finalD) >>> 1);
  let p = ops.length;
  let x = n;
  let y = m;
  for (let d = finalD; d > 0; d--) {
    const prevBase = ((d - 1) * d) >>> 1;
    const k = x - y;
    const slot = (k + d) >> 1;
    const down = k === -d || (k !== d && trace[prevBase + slot - 1] < trace[prevBase + slot]);
    const prevX = trace[prevBase + (down ? slot : slot - 1)];
    const prevY = prevX - (down ? k + 1 : k - 1);
    while (x > prevX && y > prevY) {
      ops[--p] = EQUAL;
      x--;
      y--;
    }
    ops[--p] = down ? INSERT : DELETE;
    x = prevX;
    y = prevY;
  }
  while (x > 0) {
    ops[--p] = EQUAL;
    x--;
  }
  return ops;
}

/**
 * Accumulates tokens into segments. Edits between equal runs are buffered so
 * that each change region is emitted as one `delete` then one `insert`.
 * When `refine` is set, each region holding both a deletion and an insertion
 * is re-diffed at char level before it is emitted.
 */
class SegmentBuilder {
  private readonly segments: DiffSegment[] = [];
  private equal: string[] = [];
  private deleted: string[] = [];
  private inserted: string[] = [];

  constructor(private readonly refine: Budget | null) {}

  push(op: OpCode, value: string): void {
    if (value === "") return;
    if (op === EQUAL) {
      if (this.deleted.length || this.inserted.length) this.flushEdits();
      this.equal.push(value);
    } else {
      if (this.equal.length) this.flushEqual();
      (op === DELETE ? this.deleted : this.inserted).push(value);
    }
  }

  finish(): DiffSegment[] {
    this.flushEqual();
    this.flushEdits();
    return this.segments;
  }

  private flushEqual(): void {
    if (!this.equal.length) return;
    this.append("equal", this.equal.join(""));
    this.equal = [];
  }

  private flushEdits(): void {
    const deleted = this.deleted.join("");
    const inserted = this.inserted.join("");
    this.deleted = [];
    this.inserted = [];

    if (this.refine && this.refine.remaining > 0 && deleted && inserted) {
      const [a, aIds] = codePoints(deleted);
      const [b, bIds] = codePoints(inserted);
      const sub = new SegmentBuilder(null);
      diffSequences(aIds, bIds, a, b, this.refine, sub);
      for (const segment of sub.finish()) this.append(segment.type, segment.value);
      return;
    }

    if (deleted) this.append("delete", deleted);
    if (inserted) this.append("insert", inserted);
  }

  /** Append while keeping the invariants: merge equal neighbours, order deletes before inserts. */
  private append(type: DiffSegment["type"], value: string): void {
    const segments = this.segments;
    const last = segments[segments.length - 1];
    if (last && last.type === type) {
      last.value += value;
    } else if (type === "delete" && last?.type === "insert") {
      const beforeLast = segments[segments.length - 2];
      if (beforeLast?.type === "delete") beforeLast.value += value;
      else segments.splice(segments.length - 1, 0, { type, value });
    } else {
      segments.push({ type, value });
    }
  }
}

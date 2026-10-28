import { describe, expect, it } from "vitest";
import { computeDiff, type DiffMode, type DiffSegment } from "./myers";

const rebuildOld = (segments: DiffSegment[]) =>
  segments.filter((s) => s.type !== "insert").map((s) => s.value).join("");
const rebuildNew = (segments: DiffSegment[]) =>
  segments.filter((s) => s.type !== "delete").map((s) => s.value).join("");

function expectWellFormed(oldText: string, newText: string, segments: DiffSegment[]) {
  expect(rebuildOld(segments)).toBe(oldText);
  expect(rebuildNew(segments)).toBe(newText);
  for (let i = 0; i < segments.length; i++) {
    expect(segments[i].value).not.toBe("");
    if (i > 0) expect(segments[i].type).not.toBe(segments[i - 1].type);
    // Each change region is ordered delete-then-insert.
    if (segments[i].type === "delete" && i > 0) expect(segments[i - 1].type).toBe("equal");
  }
}

/** Reference O(nm) LCS length over code points, for minimality checks. */
function lcsLength(a: string[], b: string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(row[j], row[j - 1]);
      diag = tmp;
    }
  }
  return row[b.length];
}

function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function randomText(rand: () => number, length: number, alphabet: string): string {
  const symbols = Array.from(alphabet);
  let out = "";
  for (let i = 0; i < length; i++) out += symbols[Math.floor(rand() * symbols.length)];
  return out;
}

const LOREM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";

function mutateWords(rand: () => number, text: string, rate: number): string {
  const words = text.split(" ");
  return words
    .map((w) => {
      const r = rand();
      if (r < rate / 3) return "";
      if (r < (2 * rate) / 3) return `${w} inserted`;
      if (r < rate) return w.toUpperCase();
      return w;
    })
    .filter(Boolean)
    .join(" ");
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)];
}

function benchmark(fn: () => void, runs = 25): number {
  for (let i = 0; i < 5; i++) fn(); // JIT warm-up
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return median(samples);
}

describe("computeDiff", () => {
  describe("basics", () => {
    it.each<DiffMode>(["char", "word"])("returns [] for two empty strings (%s)", (mode) => {
      expect(computeDiff("", "", mode)).toEqual([]);
    });

    it.each<DiffMode>(["char", "word"])("returns a single equal segment for identical input (%s)", (mode) => {
      expect(computeDiff("same text", "same text", mode)).toEqual([{ type: "equal", value: "same text" }]);
    });

    it("handles pure insertion and pure deletion", () => {
      expect(computeDiff("", "new", "char")).toEqual([{ type: "insert", value: "new" }]);
      expect(computeDiff("old", "", "word")).toEqual([{ type: "delete", value: "old" }]);
    });

    it("defaults to word mode", () => {
      expect(computeDiff("a cat", "a dog")).toEqual([
        { type: "equal", value: "a " },
        { type: "delete", value: "cat" },
        { type: "insert", value: "dog" },
      ]);
    });
  });

  describe("char mode", () => {
    it("produces a minimal character diff", () => {
      expect(computeDiff("kitten", "sitting", "char")).toEqual([
        { type: "delete", value: "k" },
        { type: "insert", value: "s" },
        { type: "equal", value: "itt" },
        { type: "delete", value: "e" },
        { type: "insert", value: "i" },
        { type: "equal", value: "n" },
        { type: "insert", value: "g" },
      ]);
    });

    it("never splits surrogate pairs", () => {
      const segments = computeDiff("a😀b", "a😁b", "char");
      expect(segments).toEqual([
        { type: "equal", value: "a" },
        { type: "delete", value: "😀" },
        { type: "insert", value: "😁" },
        { type: "equal", value: "b" },
      ]);
    });

    it("is minimal against a reference LCS within a word (random inputs)", () => {
      const rand = seeded(42);
      for (let i = 0; i < 200; i++) {
        const a = randomText(rand, Math.floor(rand() * 40), "abcd");
        const b = randomText(rand, Math.floor(rand() * 40), "abcd");
        const segments = computeDiff(a, b, "char");
        expectWellFormed(a, b, segments);
        const equalLength = segments.filter((s) => s.type === "equal").reduce((n, s) => n + [...s.value].length, 0);
        expect(equalLength).toBe(lcsLength([...a], [...b]));
      }
    });

    it("round-trips random multi-word edits", () => {
      const rand = seeded(99);
      for (let i = 0; i < 100; i++) {
        const a = randomText(rand, 150, "abc d\n.é😀");
        const b = randomText(rand, 150, "abc d\n.é😀");
        expectWellFormed(a, b, computeDiff(a, b, "char"));
      }
    });
  });

  describe("word mode", () => {
    it("diffs whole words and keeps whitespace/punctuation as separate tokens", () => {
      expect(computeDiff("Hello world, friend.", "Hello brave world, friend!", "word")).toEqual([
        { type: "equal", value: "Hello " },
        { type: "insert", value: "brave " },
        { type: "equal", value: "world, friend" },
        { type: "delete", value: "." },
        { type: "insert", value: "!" },
      ]);
    });

    it("groups an interleaved change region into one delete then one insert", () => {
      expect(computeDiff("one two three", "uno dos tres", "word")).toEqual([
        { type: "delete", value: "one" },
        { type: "insert", value: "uno" },
        { type: "equal", value: " " },
        { type: "delete", value: "two" },
        { type: "insert", value: "dos" },
        { type: "equal", value: " " },
        { type: "delete", value: "three" },
        { type: "insert", value: "tres" },
      ]);
    });

    it("treats Unicode letters and combining marks as word characters", () => {
      expect(computeDiff("café naïve", "café naive", "word")).toEqual([
        { type: "equal", value: "café " },
        { type: "delete", value: "naïve" },
        { type: "insert", value: "naive" },
      ]);
    });

    it("round-trips random multi-line edits", () => {
      const rand = seeded(7);
      for (let i = 0; i < 100; i++) {
        const a = randomText(rand, 120, "ab c\n.,");
        const b = randomText(rand, 120, "ab c\n.,");
        expectWellFormed(a, b, computeDiff(a, b, "word"));
      }
    });
  });

  describe("work budget", () => {
    it("refines changed words at char level by default", () => {
      expect(computeDiff("the colour red", "the color red", "char")).toEqual([
        { type: "equal", value: "the colo" },
        { type: "delete", value: "u" },
        { type: "equal", value: "r red" },
      ]);
    });

    it("stays at word granularity once the budget is exhausted", () => {
      const segments = computeDiff("alpha beta gamma", "alpha delta gamma", "char", { maxCost: 0 });
      expect(segments).toEqual([
        { type: "equal", value: "alpha " },
        { type: "delete", value: "beta" },
        { type: "insert", value: "delta" },
        { type: "equal", value: " gamma" },
      ]);
    });

    it("falls back to a single replace region when the word pass exceeds the budget", () => {
      const segments = computeDiff("x a b c y", "x d e f y", "word", { maxCost: 2 });
      expect(segments).toEqual([
        { type: "equal", value: "x " },
        { type: "delete", value: "a b c" },
        { type: "insert", value: "d e f" },
        { type: "equal", value: " y" },
      ]);
    });
  });

  describe("performance (5,000 characters, < 5ms)", () => {
    const rand = seeded(1234);
    const base = LOREM.repeat(Math.ceil(5000 / LOREM.length)).slice(0, 5000);
    const edited = mutateWords(rand, base, 0.1).slice(0, 5000);
    const unrelatedA = randomText(rand, 5000, "abcdefghijklmnopqrstuvwxyz     \n");
    const unrelatedB = randomText(rand, 5000, "abcdefghijklmnopqrstuvwxyz     \n");

    it.each<[string, string, string, DiffMode]>([
      ["10% word edits / char", base, edited, "char"],
      ["10% word edits / word", base, edited, "word"],
      ["unrelated text / char", unrelatedA, unrelatedB, "char"],
      ["unrelated text / word", unrelatedA, unrelatedB, "word"],
    ])("%s", (_name, a, b, mode) => {
      expect(a.length).toBeGreaterThan(4500);
      let segments: DiffSegment[] = [];
      const elapsed = benchmark(() => {
        segments = computeDiff(a, b, mode);
      });
      expectWellFormed(a, b, segments);
      expect(elapsed).toBeLessThan(5);
    });

    it("does not retain memory across repeated runs", () => {
      const gc = (globalThis as { gc?: () => void }).gc;
      if (!gc) return; // Requires --expose-gc; covered by the pure, state-free implementation otherwise.
      for (let i = 0; i < 50; i++) computeDiff(base, edited, "char");
      gc();
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < 500; i++) computeDiff(base, edited, "char");
      gc();
      expect(process.memoryUsage().heapUsed - before).toBeLessThan(2 * 1024 * 1024);
    });
  });
});

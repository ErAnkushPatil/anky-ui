import { posix } from "node:path";

/** Matches the specifier of `from "x"`, `import "x"`, `import("x")` and `export … from "x"`. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"'\n]+)\2/g;
const SOURCE_EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

/** Basename without extension: `components/InlineDiff.tsx` -> `InlineDiff`. */
export function moduleName(file: string): string {
  const base = posix.basename(file);
  return base.slice(0, base.length - posix.extname(base).length);
}

/** Target file name in the flat output directory. */
export function targetFileName(file: string): string {
  return posix.basename(file);
}

/**
 * Rewrite relative imports of `file` (a path relative to the registry root) for the flat output layout,
 * e.g. `../dom/useSelectionAnchor` -> `./useSelectionAnchor`.
 *
 * @param available every registry file being copied in the same run. Imports must resolve to one of them.
 * @throws if a relative import does not resolve to an available file.
 */
export function rewriteImports(source: string, file: string, available: ReadonlySet<string>): string {
  const dir = posix.dirname(file);
  return source.replace(SPECIFIER, (match, prefix: string, quote: string, specifier: string) => {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return match;
    const resolved = posix.normalize(posix.join(dir, specifier));
    const target = [resolved, ...SOURCE_EXTENSIONS.map((ext) => resolved + ext)].find((p) => available.has(p));
    if (!target) {
      throw new Error(`${file}: import "${specifier}" is not part of the copied files. Check registryDependencies.`);
    }
    return `${prefix}${quote}./${moduleName(target)}${quote}`;
  });
}

/** Relative import specifiers of a source file. */
export function relativeImports(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((m) => m[3]!).filter((s) => s.startsWith("./") || s.startsWith("../"));
}

/** Banner prepended to copied files. Comments may precede a `"use client"` directive. */
export function banner(item: string, version: string): string {
  return `// Anky UI ${item} v${version}, added with \`npx anky-ui add ${item}\`. You own this file: edit it freely.\n`;
}

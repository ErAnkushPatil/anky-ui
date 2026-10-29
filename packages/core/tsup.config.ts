import { defineConfig } from "tsup";

// Two separate builds so the "use client" banner only lands on the React entry.
// Bundlers drop per-file directives, so it has to be added back to the output.
export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    target: "es2022",
    banner: { js: '"use client";' },
  },
  {
    entry: { utils: "src/utils.ts" },
    format: ["esm", "cjs"],
    dts: true,
    target: "es2022",
  },
]);

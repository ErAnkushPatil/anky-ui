// Copies the component sources from @erankushpatil/anky-ui into ./registry so the published CLI is self-contained.
import { cpSync, rmSync } from "node:fs";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../core/src/", import.meta.url));
const target = fileURLToPath(new URL("../registry/", import.meta.url));

// Entry points only re-export; components are copied individually.
const isEntryPoint = (rel) => rel === "utils.ts" || rel === "index.ts" || rel.endsWith("/index.ts");

rmSync(target, { recursive: true, force: true });
cpSync(source, target, {
  recursive: true,
  filter: (path) => {
    const rel = relative(source, path).split(sep).join("/");
    return !/\.test\.tsx?$/.test(rel) && !isEntryPoint(rel);
  },
});
console.log(`registry synced from ${source}`);

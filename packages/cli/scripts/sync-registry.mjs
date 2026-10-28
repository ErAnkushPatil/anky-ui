// Copies the component sources from @erankushpatil/anky-ui into ./registry so the published CLI is self-contained.
import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../core/src/", import.meta.url));
const target = fileURLToPath(new URL("../registry/", import.meta.url));

rmSync(target, { recursive: true, force: true });
cpSync(source, target, {
  recursive: true,
  filter: (path) => !/\.test\.tsx?$/.test(path) && !/[\\/]index\.ts$/.test(path),
});
console.log(`registry synced from ${source}`);

#!/usr/bin/env node
import { main } from "./cli.js";

main(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`anky-ui: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, type CliEnv } from "./cli.js";
import { detectPackageManager, detectProject, installCommand, ProjectNotFoundError } from "./project.js";
import { FLOATING_UI, REGISTRY, UnknownItemError, packageName, resolveItems } from "./registry.js";
import { relativeImports, rewriteImports, targetFileName } from "./transform.js";

const CORE_SRC = fileURLToPath(new URL("../../core/src/", import.meta.url));
const CORE_PKG = JSON.parse(readFileSync(new URL("../../core/package.json", import.meta.url), "utf8"));
const ROOT_PKG = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
const CLI_PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anky-ui-cli-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>, pkg: object = { dependencies: { react: "^19.0.0" } }) {
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

async function run(args: string[], options: { cwd?: string; installStatus?: number } = {}) {
  let stdout = "";
  let stderr = "";
  const install = vi.fn(() => options.installStatus ?? 0);
  const env: CliEnv = {
    cwd: options.cwd ?? dir,
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    registryRoot: CORE_SRC,
    install,
  };
  const code = await main(args, env);
  return { code, stdout, stderr, install };
}

const read = (path: string) => readFileSync(join(dir, path), "utf8");

describe("registry", () => {
  it("lists every relative import of an item inside its dependency closure", () => {
    for (const item of REGISTRY) {
      const closure = resolveItems([item.name]);
      const available = new Set(closure.flatMap((i) => i.files));
      for (const file of item.files) {
        const source = readFileSync(join(CORE_SRC, file), "utf8");
        expect(() => rewriteImports(source, file, available), `${item.name}: ${file}`).not.toThrow();
      }
    }
  });

  it("declares exactly the npm packages each item's files import", () => {
    for (const item of REGISTRY) {
      const imported = new Set<string>();
      for (const file of item.files) {
        const source = readFileSync(join(CORE_SRC, file), "utf8");
        for (const [, spec] of source.matchAll(/\bfrom\s*["']([^"'.][^"']*)["']/g)) {
          const name = spec!.startsWith("@") ? spec!.split("/").slice(0, 2).join("/") : spec!.split("/")[0]!;
          if (name !== "react" && name !== "react-dom") imported.add(name);
        }
      }
      expect([...imported].sort(), item.name).toEqual(item.dependencies.map(packageName).sort());
    }
  });

  it("only depends on @floating-ui/react, at the same range as @erankushpatil/anky-ui", () => {
    const all = new Set(REGISTRY.flatMap((item) => item.dependencies));
    expect([...all]).toEqual([FLOATING_UI]);
    expect(`@floating-ui/react@${CORE_PKG.dependencies["@floating-ui/react"]}`).toBe(FLOATING_UI);
  });

  it("has unique names and flat file names", () => {
    expect(new Set(REGISTRY.map((i) => i.name)).size).toBe(REGISTRY.length);
    const targets = REGISTRY.flatMap((i) => i.files.map(targetFileName));
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("resolves dependencies first and de-duplicates", () => {
    expect(resolveItems(["selection-palette", "inline-diff", "use-selection-anchor"]).map((i) => i.name)).toEqual([
      "use-selection-anchor",
      "announce",
      "selection-palette",
      "diff",
      "inline-diff",
    ]);
  });

  it("rejects unknown names", () => {
    expect(() => resolveItems(["inline-diff", "nope", "nah"])).toThrow(UnknownItemError);
    expect(() => resolveItems(["nope"])).toThrow("Unknown component: nope");
  });

  it("parses package names from specs", () => {
    expect(packageName("@floating-ui/react@^0.27.0")).toBe("@floating-ui/react");
    expect(packageName("react@19")).toBe("react");
    expect(packageName("@scope/pkg")).toBe("@scope/pkg");
  });
});

describe("rewriteImports", () => {
  const available = new Set(["components/SelectionPalette.tsx", "dom/useSelectionAnchor.ts", "diff/myers.ts"]);

  it("flattens relative imports and keeps package imports", () => {
    const source = [
      `import { useEffect } from "react";`,
      `import { useSelectionAnchor } from "../dom/useSelectionAnchor";`,
      `import type { DiffSegment } from '../diff/myers';`,
      `export * from "../diff/myers";`,
      `const lazy = () => import("../diff/myers");`,
    ].join("\n");
    expect(rewriteImports(source, "components/SelectionPalette.tsx", available)).toBe(
      [
        `import { useEffect } from "react";`,
        `import { useSelectionAnchor } from "./useSelectionAnchor";`,
        `import type { DiffSegment } from './myers';`,
        `export * from "./myers";`,
        `const lazy = () => import("./myers");`,
      ].join("\n"),
    );
  });

  it("throws when an import is not being copied", () => {
    expect(() => rewriteImports(`import x from "../hooks/missing";`, "components/A.tsx", available)).toThrow(
      /hooks\/missing" is not part of the copied files/,
    );
  });

  it("extracts relative imports", () => {
    expect(relativeImports(`import a from "a"; import b from "./b"; export * from "../c";`)).toEqual(["./b", "../c"]);
  });
});

describe("detectProject", () => {
  it("finds the nearest package.json, src/ layout, TypeScript and a Tailwind config", () => {
    project({ "tsconfig.json": "{}", "tailwind.config.ts": "export default {}", "src/main.tsx": "" });
    mkdirSync(join(dir, "src", "deep"), { recursive: true });
    const info = detectProject(join(dir, "src", "deep"));
    expect(info).toMatchObject({ root: dir, tailwindConfig: "tailwind.config.ts", typescript: true, hasSrcDir: true });
  });

  it("detects Tailwind v4 from package.json when there is no config file", () => {
    project({}, { devDependencies: { tailwindcss: "^4.1.0" } });
    expect(detectProject(dir)).toMatchObject({ tailwindConfig: null, tailwindVersion: "^4.1.0", hasSrcDir: false, typescript: false });
  });

  it("detects the package manager from the packageManager field or the nearest lockfile", () => {
    mkdirSync(join(dir, "apps", "web"), { recursive: true });
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    expect(detectPackageManager(join(dir, "apps", "web"))).toBe("pnpm");
    expect(detectPackageManager(join(dir, "apps", "web"), { packageManager: "yarn@4.0.0" })).toBe("yarn");
    expect(installCommand("npm", ["a@1"])).toEqual(["npm", ["install", "a@1"]]);
    expect(installCommand("pnpm", ["a@1"])).toEqual(["pnpm", ["add", "a@1"]]);
  });

  it("throws when there is no package.json", () => {
    expect(() => detectProject(join(fileURLToPath(new URL("/", import.meta.url)), "__no_project__"))).toThrow(ProjectNotFoundError);
  });
});

describe("anky-ui add", () => {
  it("copies a component and its hook into src/components/anky with flattened imports", async () => {
    project({ "src/main.tsx": "", "tsconfig.json": "{}", "pnpm-lock.yaml": "" });
    const { code, stdout, install } = await run(["add", "selection-palette"]);

    expect(code).toBe(0);
    expect(readdirSync(join(dir, "src/components/anky")).sort()).toEqual(["SelectionPalette.tsx", "announce.ts", "useSelectionAnchor.ts"]);
    const palette = read("src/components/anky/SelectionPalette.tsx");
    expect(palette).toContain(`from "./useSelectionAnchor"`);
    expect(palette).not.toMatch(/from "\.\.\//);
    expect(palette.split("\n")[0]).toMatch(/^\/\/ Anky UI selection-palette v\d/);
    expect(palette).toContain(`"use client";`);
    expect(install).toHaveBeenCalledWith("pnpm", ["add", FLOATING_UI], dir);
    expect(stdout).toContain(`import { SelectionPalette } from "./src/components/anky/SelectionPalette";`);
    expect(stdout).toContain("Tailwind CSS not detected");
  });

  it("uses components/anky without a src directory and skips installed dependencies", async () => {
    project({ "tailwind.config.js": "" }, { dependencies: { react: "^19.0.0", "@floating-ui/react": "^0.27.2" } });
    const { code, stdout, install } = await run(["add", "inline-diff"]);

    expect(code).toBe(0);
    expect(readdirSync(join(dir, "components/anky")).sort()).toEqual(["InlineDiff.tsx", "announce.ts", "myers.ts"]);
    expect(read("components/anky/InlineDiff.tsx")).toContain(`from "./myers"`);
    expect(install).not.toHaveBeenCalled();
    expect(stdout).toContain("Tailwind (tailwind.config.js)");
    expect(stdout).not.toContain("Tailwind CSS not detected");
  });

  it("adds ghost-input as a single file with no dependencies", async () => {
    project({ "src/index.ts": "" });
    const { code, install } = await run(["add", "ghost-input"]);
    expect(code).toBe(0);
    expect(readdirSync(join(dir, "src/components/anky"))).toEqual(["GhostInput.tsx"]);
    expect(install).not.toHaveBeenCalled();
  });

  it("adds everything with --all into a custom --path", async () => {
    project({});
    const { code } = await run(["add", "--all", "--path", "app/ui/anky", "--no-install"]);
    expect(code).toBe(0);
    expect(readdirSync(join(dir, "app/ui/anky")).sort()).toEqual([
      "GhostInput.tsx",
      "InlineDiff.tsx",
      "SelectionPalette.tsx",
      "announce.ts",
      "editorAdapter.ts",
      "lexical.ts",
      "myers.ts",
      "parser.ts",
      "prosemirror.ts",
      "providers.ts",
      "tiptap.ts",
      "useEditorAnchor.ts",
      "useOptimisticAIState.ts",
      "useSelectionAnchor.ts",
    ]);
    expect(read("app/ui/anky/useOptimisticAIState.ts")).toContain(`from "./parser"`);
  });

  it("never overwrites local edits unless --overwrite is passed", async () => {
    project({ "src/a.ts": "" }, { dependencies: { react: "19", "@floating-ui/react": "0.27.0" } });
    await run(["add", "inline-diff"]);

    const again = await run(["add", "inline-diff"]);
    expect(again.stdout).toMatch(/= src\/components\/anky\/InlineDiff\.tsx {2}\(unchanged\)/);

    writeFileSync(join(dir, "src/components/anky/InlineDiff.tsx"), "// my edits");
    const kept = await run(["add", "inline-diff"]);
    expect(kept.code).toBe(0);
    expect(kept.stdout).toContain("exists with local changes; kept");
    expect(read("src/components/anky/InlineDiff.tsx")).toBe("// my edits");

    const replaced = await run(["add", "inline-diff", "--overwrite"]);
    expect(replaced.stdout).toContain("(overwrote)");
    expect(read("src/components/anky/InlineDiff.tsx")).toContain("export function InlineDiff");
  });

  it("writes nothing and installs nothing with --dry-run", async () => {
    project({ "src/a.ts": "" });
    const { code, stdout, install } = await run(["add", "selection-palette", "--dry-run"]);
    expect(code).toBe(0);
    expect(existsSync(join(dir, "src/components"))).toBe(false);
    expect(install).not.toHaveBeenCalled();
    expect(stdout).toContain("(would create)");
    expect(stdout).toContain(`Dependencies to install: npm install ${FLOATING_UI}`);
  });

  it("prints the install command with --no-install and fails when installation fails", async () => {
    project({ "src/a.ts": "", "yarn.lock": "" });
    const skipped = await run(["add", "inline-diff", "--no-install"]);
    expect(skipped.install).not.toHaveBeenCalled();
    expect(skipped.stdout).toContain(`Dependencies to install: yarn add ${FLOATING_UI}`);

    const failed = await run(["add", "selection-palette"], { installStatus: 2 });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("Dependency installation failed (exit code 2)");
  });

  it("resolves --cwd relative to the working directory", async () => {
    mkdirSync(join(dir, "web"));
    writeFileSync(join(dir, "web", "package.json"), "{}");
    const { code } = await run(["add", "ghost-input", "--cwd", "web"]);
    expect(code).toBe(0);
    expect(existsSync(join(dir, "web/components/anky/GhostInput.tsx"))).toBe(true);
  });

  it("warns about missing react and TypeScript", async () => {
    project({}, {});
    const { stdout } = await run(["add", "ghost-input"]);
    expect(stdout).toContain("react is not a dependency");
    expect(stdout).toContain("No tsconfig.json found");
  });

  it("fails on unknown components and missing arguments", async () => {
    project({});
    const unknown = await run(["add", "fancy-button"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Unknown component: fancy-button");
    expect(unknown.stderr).toContain("selection-palette");

    const empty = await run(["add"]);
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain("Name at least one component");
  });
});

describe("anky-ui", () => {
  it("uses a single publishable CLI package with matching implementation metadata", () => {
    expect(ROOT_PKG.name).toBe("anky-ui");
    expect(ROOT_PKG.bin["anky-ui"]).toBe("./packages/cli/dist/index.js");
    expect(ROOT_PKG.files).toContain("packages/cli/registry");
    expect(ROOT_PKG.files).toContain("packages/cli/package.json");
    expect(CLI_PKG.name).toBe("@anky/cli");
    expect(CLI_PKG.private).toBe(true);
    expect(CLI_PKG.version).toBe(ROOT_PKG.version);
    expect(CORE_PKG.name).toBe("@erankushpatil/anky-ui");
  });

  it("prints help, version and the component list", async () => {
    expect((await run(["--help"])).stdout).toContain("Usage: anky-ui <command>");
    expect((await run([])).code).toBe(1);
    expect((await run(["--version"])).stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
    const list = await run(["list"]);
    for (const item of REGISTRY) expect(list.stdout).toContain(item.name);
  });

  it("rejects unknown commands and flags", async () => {
    expect((await run(["remove", "x"])).stderr).toContain(`Unknown command "remove"`);
    const flag = await run(["add", "--force"]);
    expect(flag.code).toBe(1);
    expect(flag.stderr).toMatch(/Unknown option '--force'/);
  });
});

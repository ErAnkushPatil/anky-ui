import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { detectProject, defaultTargetDir, installCommand, ProjectNotFoundError, type ProjectInfo } from "./project.js";
import { REGISTRY, UnknownItemError, packageName, resolveItems } from "./registry.js";
import { banner, moduleName, rewriteImports, targetFileName } from "./transform.js";

export type Installer = (command: string, args: readonly string[], cwd: string) => number | Promise<number>;

export interface CliEnv {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Directory holding the component sources (mirrors `@erankushpatil/anky-ui/src`). Defaults to the bundled registry. */
  registryRoot?: string;
  /** Runs the package manager. Defaults to a synchronous child process inheriting stdio. */
  install?: Installer;
}

export type FileStatus = "created" | "overwritten" | "unchanged" | "skipped";

const HELP = `Usage: anky-ui <command> [options]

Commands:
  add <component...>   Copy components (and the files they import) into your project
  list                 Show available components

Options for add:
  -a, --all            Add every component
  -p, --path <dir>     Output directory, relative to the project root
                       (default: src/components/anky, or components/anky without src/)
  -o, --overwrite      Replace existing files that differ
      --dry-run        Print what would change without writing or installing
      --no-install     Do not install missing npm dependencies
      --cwd <dir>      Run as if started in <dir>

  -h, --help           Show this help
  -v, --version        Show the CLI version

Examples:
  npx anky-ui add selection-palette
  npx anky-ui add inline-diff ghost-input --path app/ui/anky
`;

export async function main(argv: readonly string[], env: CliEnv): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        all: { type: "boolean", short: "a" },
        path: { type: "string", short: "p" },
        overwrite: { type: "boolean", short: "o" },
        "dry-run": { type: "boolean" },
        "no-install": { type: "boolean" },
        cwd: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    env.stderr(`${(error as Error).message}\n\n${HELP}`);
    return 1;
  }

  const { values, positionals } = parsed;
  const [command, ...names] = positionals;

  if (values.version) {
    env.stdout(`${cliVersion()}\n`);
    return 0;
  }
  if (values.help || !command || command === "help") {
    env.stdout(HELP);
    return values.help || command === "help" ? 0 : 1;
  }

  switch (command) {
    case "list":
      env.stdout(listText());
      return 0;
    case "add":
      return add(names, {
        all: values.all ?? false,
        path: values.path,
        overwrite: values.overwrite ?? false,
        dryRun: values["dry-run"] ?? false,
        install: !values["no-install"],
        cwd: resolve(env.cwd, values.cwd ?? "."),
      }, env);
    default:
      env.stderr(`Unknown command "${command}".\n\n${HELP}`);
      return 1;
  }
}

interface AddOptions {
  all: boolean;
  path: string | undefined;
  overwrite: boolean;
  dryRun: boolean;
  install: boolean;
  cwd: string;
}

async function add(names: readonly string[], options: AddOptions, env: CliEnv): Promise<number> {
  const requested = options.all ? REGISTRY.map((item) => item.name) : [...new Set(names)];
  if (!requested.length) {
    env.stderr(`Name at least one component, or pass --all.\n\n${listText()}`);
    return 1;
  }

  let project: ProjectInfo;
  let items;
  try {
    items = resolveItems(requested);
    project = detectProject(options.cwd);
  } catch (error) {
    if (error instanceof UnknownItemError) {
      env.stderr(`${error.message}\n\n${listText()}`);
      return 1;
    }
    if (error instanceof ProjectNotFoundError) {
      env.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const registryRoot = env.registryRoot ?? defaultRegistryRoot();
  const version = cliVersion();
  const targetDir = resolve(project.root, options.path ?? defaultTargetDir(project));
  const files = items.flatMap((item) => item.files.map((file) => ({ item: item.name, file })));
  const available = new Set(files.map(({ file }) => file));
  const display = (path: string) => relative(project.root, path).split(sep).join("/");

  env.stdout(`Anky UI: adding ${requested.join(", ")} to ${project.root}\n${describeProject(project)}\n\n`);

  const results: Array<{ path: string; status: FileStatus }> = [];
  for (const { item, file } of files) {
    const source = readFileSync(join(registryRoot, file), "utf8");
    const content = banner(item, version) + rewriteImports(source, file, available);
    const path = join(targetDir, targetFileName(file));
    const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
    const status: FileStatus =
      existing === null ? "created"
      : normalizeEol(existing) === normalizeEol(content) ? "unchanged"
      : options.overwrite ? "overwritten"
      : "skipped";
    if ((status === "created" || status === "overwritten") && !options.dryRun) {
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(path, content);
    }
    results.push({ path, status });
  }

  const verb = options.dryRun ? { created: "would create", overwritten: "would overwrite" } : { created: "created", overwritten: "overwrote" };
  for (const { path, status } of results) {
    const line =
      status === "created" ? `  + ${display(path)}  (${verb.created})`
      : status === "overwritten" ? `  ~ ${display(path)}  (${verb.overwritten})`
      : status === "unchanged" ? `  = ${display(path)}  (unchanged)`
      : `  ! ${display(path)}  (exists with local changes; kept. Use --overwrite to replace)`;
    env.stdout(`${line}\n`);
  }

  const warnings: string[] = [];
  if (!project.dependencies.has("react")) warnings.push("react is not a dependency of this project. The components need React 18 or 19.");
  if (!project.typescript) warnings.push("No tsconfig.json found. The copied files are TypeScript (.ts/.tsx).");
  if (!project.tailwindConfig && !project.tailwindVersion) {
    warnings.push("Tailwind CSS not detected. Components are unstyled; style them via the anky-ui-* class names.");
  }

  const missing = [...new Set(items.flatMap((item) => item.dependencies))].filter(
    (spec) => !project.dependencies.has(packageName(spec)),
  );
  let exitCode = 0;
  if (missing.length) {
    const [command, args] = installCommand(project.packageManager, missing);
    const commandLine = [command, ...args].join(" ");
    if (options.dryRun || !options.install) {
      env.stdout(`\nDependencies to install: ${commandLine}\n`);
    } else {
      env.stdout(`\nInstalling dependencies: ${commandLine}\n`);
      const status = await (env.install ?? spawnInstaller)(command, args, project.root);
      if (status !== 0) {
        env.stderr(`Dependency installation failed (exit code ${status}). Run it manually: ${commandLine}\n`);
        exitCode = 1;
      }
    }
  }

  for (const warning of warnings) env.stdout(`\nNote: ${warning}\n`);

  if (!options.dryRun) {
    const skipped = results.filter((r) => r.status === "skipped").length;
    if (skipped) {
      env.stdout(`\n${skipped} file${skipped > 1 ? "s were" : " was"} kept unchanged. Re-run with --overwrite to update.\n`);
    } else {
      const hints = items
        .filter((item) => requested.includes(item.name))
        .map((item) => `  import { ${item.exportName} } from "./${display(join(targetDir, moduleName(item.files[0]!)))}";`);
      env.stdout(`\nDone. Adjust the import path to your file:\n${hints.join("\n")}\n`);
    }
  }
  return exitCode;
}

function describeProject(project: ProjectInfo): string {
  const tailwind = project.tailwindConfig
    ? `Tailwind (${project.tailwindConfig})`
    : project.tailwindVersion
      ? `Tailwind ${project.tailwindVersion}`
      : "no Tailwind";
  return `Detected: ${project.packageManager}, ${project.typescript ? "TypeScript" : "JavaScript"}, ${tailwind}`;
}

function listText(): string {
  const width = Math.max(...REGISTRY.map((item) => item.name.length));
  const rows = REGISTRY.map((item) => `  ${item.name.padEnd(width)}  ${item.description}`);
  return `Available components:\n${rows.join("\n")}\n`;
}

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * Command line for cmd.exe. Package managers are .cmd shims on Windows, which need a shell, and cmd.exe
 * treats `^` as an escape character, so unquoted `pkg@^1.0.0` would lose its range. Arguments come from
 * the registry, never from user input.
 */
export function windowsCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args.map((arg) => `"${arg}"`)].join(" ");
}

const spawnInstaller: Installer = (command, args, cwd) => {
  const result =
    process.platform === "win32"
      ? spawnSync(windowsCommandLine(command, args), { cwd, stdio: "inherit", shell: true })
      : spawnSync(command, args, { cwd, stdio: "inherit" });
  return result.status ?? 1;
};

/** Published package: `<pkg>/registry` (built by scripts/sync-registry.mjs). In the monorepo: `packages/core/src`. */
export function defaultRegistryRoot(): string {
  const bundled = fileURLToPath(new URL("../registry/", import.meta.url));
  return existsSync(bundled) ? bundled : fileURLToPath(new URL("../../core/src/", import.meta.url));
}

function cliVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

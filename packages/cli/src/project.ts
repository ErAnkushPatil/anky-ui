import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export const TAILWIND_CONFIGS = [
  "tailwind.config.js",
  "tailwind.config.cjs",
  "tailwind.config.mjs",
  "tailwind.config.ts",
  "tailwind.config.cts",
  "tailwind.config.mts",
] as const;

const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];

export interface ProjectInfo {
  /** Directory containing the nearest `package.json`. */
  root: string;
  packageJson: PackageJson;
  /** Tailwind config file name, if one exists at the root. */
  tailwindConfig: string | null;
  /** Declared `tailwindcss` version range, if any. Tailwind v4 projects usually have no config file. */
  tailwindVersion: string | null;
  typescript: boolean;
  hasSrcDir: boolean;
  packageManager: PackageManager;
  /** Names of all declared dependencies (prod, dev and peer). */
  dependencies: ReadonlySet<string>;
}

interface PackageJson {
  name?: string;
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export class ProjectNotFoundError extends Error {
  constructor(cwd: string) {
    super(`No package.json found in ${cwd} or any parent directory. Run this command inside your app.`);
    this.name = "ProjectNotFoundError";
  }
}

/** Inspect the project containing `cwd`. Throws {@link ProjectNotFoundError} if there is none. */
export function detectProject(cwd: string): ProjectInfo {
  const root = findUp(resolve(cwd), (dir) => isFile(join(dir, "package.json")));
  if (!root) throw new ProjectNotFoundError(cwd);

  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
  const deps = { ...packageJson.peerDependencies, ...packageJson.devDependencies, ...packageJson.dependencies };

  return {
    root,
    packageJson,
    tailwindConfig: TAILWIND_CONFIGS.find((name) => isFile(join(root, name))) ?? null,
    tailwindVersion: deps.tailwindcss ?? null,
    typescript: isFile(join(root, "tsconfig.json")) || "typescript" in deps,
    hasSrcDir: isDirectory(join(root, "src")),
    packageManager: detectPackageManager(root, packageJson),
    dependencies: new Set(Object.keys(deps)),
  };
}

/** `packageManager` field first, then the nearest lockfile (walking up for monorepos), then npm. */
export function detectPackageManager(root: string, packageJson: PackageJson = {}): PackageManager {
  const declared = packageJson.packageManager?.split("@")[0];
  if (declared === "npm" || declared === "pnpm" || declared === "yarn" || declared === "bun") return declared;
  let found: PackageManager = "npm";
  findUp(root, (dir) => {
    const hit = LOCKFILES.find(([file]) => isFile(join(dir, file)));
    if (hit) found = hit[1];
    return !!hit;
  });
  return found;
}

/** Default output directory, relative to the project root. */
export function defaultTargetDir(project: Pick<ProjectInfo, "hasSrcDir">): string {
  return project.hasSrcDir ? "src/components/anky" : "components/anky";
}

/** Command that adds `specs` as dependencies with the project's package manager. */
export function installCommand(pm: PackageManager, specs: readonly string[]): [string, string[]] {
  return [pm, [pm === "npm" ? "install" : "add", ...specs]];
}

function findUp(start: string, test: (dir: string) => boolean): string | null {
  for (let dir = start; ; dir = dirname(dir)) {
    if (test(dir)) return dir;
    if (dirname(dir) === dir) return null;
  }
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

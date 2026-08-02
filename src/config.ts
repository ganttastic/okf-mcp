import { access } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { SourceConfig } from "./connectors/types.js";
import { loadRegistry } from "./registry.js";

export const GIT_TOKEN_ENV = "OKF_GIT_TOKEN";

export interface CliOptions {
  sourcesPath?: string;
  localDirs: string[];
  gitUrls: string[];
}

/**
 * --sources <path>, --local <dir> [<dir>…], --git <url> [<url>…]
 * Value-list flags consume arguments until the next flag, because Claude
 * Desktop expands a multi-value user_config placeholder into that shape.
 */
export function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = { localDirs: [], gitUrls: [] };
  let sink: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--local") {
      sink = options.localDirs;
    } else if (arg === "--git") {
      sink = options.gitUrls;
    } else if (arg === "--sources") {
      sink = undefined;
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--sources requires a path");
      }
      options.sourcesPath = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option "${arg}" (expected --sources, --local, or --git)`);
    } else {
      if (!sink) throw new Error(`Unexpected argument "${arg}"`);
      sink.push(arg);
    }
  }
  return options;
}

/**
 * Build the source registry from every configuration channel:
 * an explicit sources.json, --local/--git flags, and the
 * OKF_MCP_LOCAL_BUNDLES / OKF_MCP_GIT_BUNDLES env vars (comma-separated).
 * Bundle names are derived from the directory or repository basename.
 */
export async function buildRegistry(
  cli: CliOptions,
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
): Promise<Map<string, SourceConfig>> {
  const registry = new Map<string, SourceConfig>();

  const explicitPath = cli.sourcesPath ?? env["OKF_MCP_SOURCES"];
  const defaultPath = resolve(cwd, "sources.json");
  if (explicitPath) {
    for (const [name, source] of await loadRegistry(resolve(cwd, explicitPath))) {
      registry.set(name, source);
    }
  } else if (await exists(defaultPath)) {
    for (const [name, source] of await loadRegistry(defaultPath)) {
      registry.set(name, source);
    }
  }

  const localDirs = [...cli.localDirs, ...splitList(env["OKF_MCP_LOCAL_BUNDLES"])].filter(usable);
  const gitUrls = [...cli.gitUrls, ...splitList(env["OKF_MCP_GIT_BUNDLES"])].filter(usable);

  for (const dir of localDirs) {
    const name = claimName(registry, basename(dir.replace(/\/+$/, "")) || "bundle");
    registry.set(name, { kind: "filesystem", location: dir });
  }
  for (const url of gitUrls) {
    const name = claimName(registry, gitBundleName(url));
    const source: SourceConfig = { kind: "git", location: url };
    if (env[GIT_TOKEN_ENV]) source.auth = { env: GIT_TOKEN_ENV };
    registry.set(name, source);
  }

  if (registry.size === 0) {
    throw new Error(
      "No bundles configured. Provide a sources.json (--sources or OKF_MCP_SOURCES), " +
        "--local <dir> for a bundle on disk, or --git <clone-url[#branch]> for a repository.",
    );
  }
  return registry;
}

/** "https://host/org/dash-wiki.git#main" → "dash-wiki" */
export function gitBundleName(url: string): string {
  const withoutBranch = url.split("#")[0].replace(/\/+$/, "");
  const last = withoutBranch.split("/").pop() ?? "bundle";
  return last.replace(/\.git$/, "") || "bundle";
}

function claimName(registry: Map<string, unknown>, base: string): string {
  if (!registry.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!registry.has(candidate)) return candidate;
  }
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((entry) => entry.trim());
}

/** A never-expanded ${user_config.…} placeholder must not become a bundle. */
function usable(entry: string): boolean {
  return entry !== "" && !entry.startsWith("${");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

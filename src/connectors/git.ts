import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FilesystemConnector } from "./filesystem.js";
import type {
  BundleHandle,
  Concept,
  OkfConnector,
  SearchHit,
  SourceConfig,
} from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_STALENESS_MINUTES = 5;
const SYNC_MARKER = "okf-mcp-synced"; // lives inside .git so it never shadows bundle content

/**
 * The git connector is the filesystem connector plus a sync policy (§4.1):
 * a single-branch clone under the cache directory, lazily pulled --ff-only
 * when a read finds it staler than the bundle's maxStaleness. Reads come
 * straight off the working tree, so an external `git pull` from cron composes
 * with this rather than fighting it.
 */
export class GitConnector implements OkfConnector {
  readonly kind = "git";
  readonly capabilities = { search: true };

  private readonly fs = new FilesystemConnector();
  private readonly cacheRoot: string;
  /** Pulls are single-flight per bundle: a burst of reads costs one pull. */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(cacheRoot?: string) {
    this.cacheRoot =
      cacheRoot ??
      process.env["OKF_MCP_CACHE_DIR"] ??
      join(homedir(), ".cache", "okf-mcp");
  }

  async resolveBundle(name: string, source: SourceConfig): Promise<BundleHandle> {
    const dir = join(this.cacheRoot, name);
    if (!(await isCloned(dir))) {
      // A failed initial clone is an error to throw — absence is not a bundle.
      await this.clone(name, source, dir);
    }
    const handle = await this.fs.resolveAt(name, source, dir);
    handle.syncedAt = await readSyncMarker(dir);
    await this.ensureFresh(handle);
    return handle;
  }

  async readIndex(bundle: BundleHandle, directory?: string): Promise<string> {
    await this.ensureFresh(bundle);
    return this.fs.readIndex(bundle, directory);
  }

  async readConcept(bundle: BundleHandle, path: string): Promise<Concept> {
    await this.ensureFresh(bundle);
    return this.fs.readConcept(bundle, path);
  }

  async listDirectories(bundle: BundleHandle): Promise<string[]> {
    await this.ensureFresh(bundle);
    return this.fs.listDirectories(bundle);
  }

  async search(bundle: BundleHandle, query: string): Promise<SearchHit[]> {
    await this.ensureFresh(bundle);
    return this.fs.search(bundle, query);
  }

  async refresh(bundle: BundleHandle): Promise<void> {
    await this.sync(bundle);
  }

  /** Staleness-driven freshness: pull only when a read finds the clone old. */
  private async ensureFresh(bundle: BundleHandle): Promise<void> {
    const maxMinutes = bundle.source.maxStalenessMinutes ?? DEFAULT_MAX_STALENESS_MINUTES;
    const syncedAt = await readSyncMarker(bundle.rootDir);
    if (syncedAt !== undefined) {
      const ageMs = Date.now() - Date.parse(syncedAt);
      if (ageMs < maxMinutes * 60_000) {
        bundle.syncedAt = syncedAt;
        return;
      }
    }
    await this.sync(bundle);
  }

  private sync(bundle: BundleHandle): Promise<void> {
    let pending = this.inflight.get(bundle.name);
    if (!pending) {
      pending = this.pull(bundle).finally(() => this.inflight.delete(bundle.name));
      this.inflight.set(bundle.name, pending);
    }
    return pending;
  }

  private async pull(bundle: BundleHandle): Promise<void> {
    const { url, branch } = parseLocation(bundle.source);
    const authedUrl = withAuth(url, bundle.source, bundle.name);
    const args = ["pull", "--ff-only", authedUrl, ...(branch ? [branch] : [])];
    try {
      await git(args, bundle.rootDir);
    } catch (err) {
      const message = (err as Error).message;
      if (isNonFastForward(message)) {
        // The clone is a read-only mirror; a pull that cannot fast-forward
        // means something else wrote to the cache directory. Recovery is
        // delete and re-clone, never merge.
        await rm(bundle.rootDir, { recursive: true, force: true });
        await this.clone(bundle.name, bundle.source, bundle.rootDir);
      } else {
        // A failed pull on an existing clone serves the tree it has, flagged
        // with its age — staleness is a fact to report.
        bundle.stale = true;
        bundle.syncedAt = await readSyncMarker(bundle.rootDir);
        return;
      }
    }
    bundle.stale = false;
    bundle.syncedAt = await markSynced(bundle.rootDir);
  }

  private async clone(name: string, source: SourceConfig, dir: string): Promise<void> {
    const { url, branch } = parseLocation(source);
    const authedUrl = withAuth(url, source, name);
    await mkdir(this.cacheRoot, { recursive: true });
    const args = [
      "clone",
      "--single-branch",
      ...(branch ? ["--branch", branch] : []),
      authedUrl,
      dir,
    ];
    try {
      await git(args, this.cacheRoot);
    } catch (err) {
      throw new Error(
        `Bundle "${name}": clone of ${url} failed — ${(err as Error).message}`,
      );
    }
    // The credential never lands on disk: the remote keeps the clean URL and
    // every pull passes the authenticated URL on the command line instead.
    await git(["remote", "set-url", "origin", url], dir);
    await markSynced(dir);
  }
}

export function parseLocation(source: SourceConfig): { url: string; branch?: string } {
  const hash = source.location.lastIndexOf("#");
  if (hash === -1) return { url: source.location };
  return {
    url: source.location.slice(0, hash),
    branch: source.location.slice(hash + 1) || undefined,
  };
}

export function withAuth(url: string, source: SourceConfig, name: string): string {
  if (!source.auth) return url;
  // SSH remotes (git@host:… or ssh://…) authenticate with keys, not tokens.
  if (!/^https?:\/\//i.test(url)) return url;
  const token = process.env[source.auth.env];
  if (!token) {
    throw new Error(
      `Bundle "${name}": auth env var ${source.auth.env} is named in the registry but not set`,
    );
  }
  const parsed = new URL(url);
  parsed.username = "x-access-token";
  parsed.password = token;
  return parsed.toString();
}

/**
 * OKF_GIT_SSH_KEY names a private key file (e.g. a GitHub deploy key) used
 * for every SSH remote. accept-new keeps first contact non-interactive
 * without ignoring a changed host key afterwards.
 */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: "0" };
  const sshKey = env["OKF_GIT_SSH_KEY"];
  if (sshKey && !sshKey.startsWith("${")) {
    merged["GIT_SSH_COMMAND"] = `ssh -i "${sshKey}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
  }
  return merged;
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv() });
    return stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr;
    throw new Error(stderr?.trim() || (err as Error).message);
  }
}

function isNonFastForward(message: string): boolean {
  return /not possible to fast-forward|refusing to merge unrelated histories|would be overwritten/i.test(
    message,
  );
}

async function isCloned(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, ".git"))).isDirectory();
  } catch {
    return false;
  }
}

async function markSynced(dir: string): Promise<string> {
  const now = new Date().toISOString();
  await writeFile(join(dir, ".git", SYNC_MARKER), now, "utf8");
  return now;
}

async function readSyncMarker(dir: string): Promise<string | undefined> {
  try {
    return (await readFile(join(dir, ".git", SYNC_MARKER), "utf8")).trim();
  } catch {
    return undefined;
  }
}

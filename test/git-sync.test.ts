import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitConnector } from "../src/connectors/git.js";
import type { SourceConfig } from "../src/connectors/types.js";

const execFileAsync = promisify(execFile);
const FIXTURE = fileURLToPath(new URL("./fixtures/with-manifest", import.meta.url));

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@test",
    ...args,
  ], { cwd });
  return stdout;
}

describe("git connector sync policy (§4.1)", () => {
  let tempDir: string;
  let origin: string;
  let connector: GitConnector;
  // maxStalenessMinutes: 0 makes every read check the origin, so the tests
  // exercise the pull path without waiting out the five-minute default.
  let source: SourceConfig;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "okf-mcp-sync-"));
    origin = join(tempDir, "origin");
    await cp(FIXTURE, origin, { recursive: true });
    await git(origin, "init", "-b", "main");
    await git(origin, "add", "-A");
    await git(origin, "commit", "-m", "fixture");
    connector = new GitConnector(join(tempDir, "cache"));
    source = { kind: "git", location: `${origin}#main`, maxStalenessMinutes: 0 };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("a stale read pulls new commits before serving", async () => {
    const bundle = await connector.resolveBundle("wiki", source);
    expect(await connector.readIndex(bundle, "operations")).toContain("Nothing here yet");

    await writeFile(join(origin, "operations", "index.md"), "# Operations\n\nNow with content.\n");
    await git(origin, "add", "-A");
    await git(origin, "commit", "-m", "update operations");

    expect(await connector.readIndex(bundle, "operations")).toContain("Now with content");
    expect(bundle.stale).toBe(false);
    expect(bundle.syncedAt).toBeDefined();
  });

  it("a failed pull serves the existing tree, flagged stale", async () => {
    const bundle = await connector.resolveBundle("wiki", source);
    // Take the origin away: the pull now fails like a network outage would.
    await rename(origin, `${origin}-gone`);

    const index = await connector.readIndex(bundle);
    expect(index).toContain("# Test Bundle"); // still served
    expect(bundle.stale).toBe(true); // staleness is a fact to report
  });

  it("a non-fast-forward pull deletes and re-clones, never merges", async () => {
    const bundle = await connector.resolveBundle("wiki", source);
    const cacheDir = bundle.rootDir;

    // Something else writes to the cache directory…
    await writeFile(join(cacheDir, "rogue.md"), "should not survive\n");
    await git(cacheDir, "add", "-A");
    await git(cacheDir, "commit", "-m", "rogue local commit");
    // …while the origin moves on independently.
    await writeFile(join(origin, "AGENTS.md"), "# Agent guide\n\nRewritten upstream.\n");
    await git(origin, "add", "-A");
    await git(origin, "commit", "-m", "diverge");

    const agents = await connector.readConcept(bundle, "AGENTS.md");
    expect(agents.raw).toContain("Rewritten upstream");
    await expect(readFile(join(cacheDir, "rogue.md"), "utf8")).rejects.toThrow();
  });

  it("an initial clone failure throws — absence is not a bundle", async () => {
    await expect(
      connector.resolveBundle("ghost", {
        kind: "git",
        location: join(tempDir, "no-such-repo"),
      }),
    ).rejects.toThrow(/clone .* failed/s);
  });

  it("a named auth env var that is unset is an error, not an anonymous retry", async () => {
    await expect(
      connector.resolveBundle("private", {
        kind: "git",
        location: "https://example.invalid/private.git#main",
        auth: { env: "OKF_TEST_TOKEN_DEFINITELY_UNSET" },
      }),
    ).rejects.toThrow(/OKF_TEST_TOKEN_DEFINITELY_UNSET/);
  });
});

import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FilesystemConnector } from "../src/connectors/filesystem.js";
import { GitConnector } from "../src/connectors/git.js";
import type { BundleHandle, OkfConnector, SourceConfig } from "../src/connectors/types.js";

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

/** Turn the fixture into a real git repo the git connector can clone. */
async function makeOrigin(dir: string): Promise<string> {
  const origin = join(dir, "origin");
  await cp(FIXTURE, origin, { recursive: true });
  await git(origin, "init", "-b", "main");
  await git(origin, "add", "-A");
  await git(origin, "commit", "-m", "fixture");
  return origin;
}

interface Lane {
  label: string;
  connector: () => OkfConnector;
  source: () => SourceConfig;
}

describe("connector contract", () => {
  let tempDir: string;
  let origin: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "okf-mcp-contract-"));
    origin = await makeOrigin(tempDir);
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // Every connector runs the same assertions against the same miniature
  // bundle, so "all connectors behave identically" is asserted, not hoped.
  const lanes: Lane[] = [
    {
      label: "filesystem",
      connector: () => new FilesystemConnector(),
      source: () => ({ kind: "filesystem", location: FIXTURE }),
    },
    {
      label: "git",
      connector: () => new GitConnector(join(tempDir, "cache")),
      source: () => ({ kind: "git", location: `${origin}#main` }),
    },
  ];

  describe.each(lanes)("$label", (lane) => {
    let connector: OkfConnector;
    let bundle: BundleHandle;

    beforeAll(async () => {
      connector = lane.connector();
      bundle = await connector.resolveBundle("test-bundle", lane.source());
    });

    it("resolves the manifest as authoritative when okf.json exists", () => {
      expect(bundle.manifestSynthesized).toBe(false);
      expect(bundle.manifest.name).toBe("test-bundle");
      expect(bundle.manifest.okf_version).toBe("0.1");
      expect(bundle.manifest.categories.map((c) => c.path)).toEqual(["business", "operations"]);
      // Unknown manifest keys ride along untouched.
      expect(bundle.manifest.conventions).toMatchObject({ concept_id: "path minus .md" });
    });

    it("reads the root index verbatim", async () => {
      const expected = await readFile(join(FIXTURE, "index.md"), "utf8");
      await expect(connector.readIndex(bundle)).resolves.toBe(expected);
    });

    it("reads a directory index verbatim", async () => {
      const expected = await readFile(join(FIXTURE, "business", "index.md"), "utf8");
      await expect(connector.readIndex(bundle, "business")).resolves.toBe(expected);
    });

    it("reads a concept as exact bytes, frontmatter unknown keys preserved", async () => {
      const expected = await readFile(join(FIXTURE, "business", "buyers-premium.md"), "utf8");
      const concept = await connector.readConcept(bundle, "business/buyers-premium.md");
      expect(concept.raw).toBe(expected);
      // The fixture deliberately lacks a trailing newline; nothing may add one.
      expect(concept.raw.endsWith("\n")).toBe(false);
      expect(concept.frontmatter["type"]).toBe("Concept");
      expect(concept.frontmatter["x_custom_weight"]).toBe(7);
      expect(concept.frontmatter["x_pipeline_run"]).toBe("2026-07-30T12:00:00Z");
      expect(concept.body).toContain("# Buyer's premium");
    });

    it("lists category directories, machinery excluded", async () => {
      await expect(connector.listDirectories(bundle)).resolves.toEqual([
        "business",
        "operations",
      ]);
    });

    it("finds concepts by substring search", async () => {
      const hits = await connector.search!(bundle, "hammer price");
      expect(hits.some((h) => h.path === join("business", "buyers-premium.md"))).toBe(true);
    });

    it("rejects paths that escape the bundle", async () => {
      await expect(connector.readConcept(bundle, "../outside.md")).rejects.toThrow(/escapes/);
    });

    it("throws on a missing file instead of returning empty content", async () => {
      await expect(connector.readConcept(bundle, "business/nope.md")).rejects.toThrow(
        /no file at/,
      );
    });
  });
});

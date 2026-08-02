import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FilesystemConnector } from "../src/connectors/filesystem.js";
import { loadRegistry } from "../src/registry.js";

const NO_MANIFEST = fileURLToPath(new URL("./fixtures/no-manifest", import.meta.url));

describe("manifest synthesis (§3)", () => {
  const connector = new FilesystemConnector();

  it("synthesizes a manifest for a bundle without okf.json", async () => {
    const bundle = await connector.resolveBundle("legacy", {
      kind: "filesystem",
      location: NO_MANIFEST,
    });
    expect(bundle.manifestSynthesized).toBe(true);
    expect(bundle.manifest.okf_version).toBe("0.1"); // from index.md frontmatter
    expect(bundle.manifest.root).toBe("index.md");
    expect(bundle.manifest.categories.map((c) => c.path)).toEqual(["alpha", "beta"]);
  });

  it("still serves reads and search from a synthesized bundle", async () => {
    const bundle = await connector.resolveBundle("legacy", {
      kind: "filesystem",
      location: NO_MANIFEST,
    });
    await expect(connector.listDirectories(bundle)).resolves.toEqual(["alpha", "beta"]);
    const concept = await connector.readConcept(bundle, "alpha/thing.md");
    expect(concept.frontmatter).toEqual({});
    expect(concept.body).toContain("Plain concept");
  });

  it("throws for a directory that is not a bundle — absence is not a bundle", async () => {
    const empty = await mkdtemp(join(tmpdir(), "okf-mcp-empty-"));
    try {
      await expect(
        connector.resolveBundle("empty", { kind: "filesystem", location: empty }),
      ).rejects.toThrow(/not an OKF bundle/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("throws for a missing directory instead of returning an empty handle", async () => {
    await expect(
      connector.resolveBundle("ghost", { kind: "filesystem", location: "/nowhere/at/all" }),
    ).rejects.toThrow(/does not exist/);
  });
});

describe("source registry (§6)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "okf-mcp-registry-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads a valid registry", async () => {
    const path = join(dir, "sources.json");
    await writeFile(
      path,
      JSON.stringify({
        wiki: {
          kind: "git",
          location: "https://example.com/wiki.git#main",
          auth: { env: "OKF_GIT_TOKEN" },
          maxStalenessMinutes: 5,
        },
        local: { kind: "filesystem", location: "~/wiki" },
      }),
    );
    const registry = await loadRegistry(path);
    expect([...registry.keys()]).toEqual(["wiki", "local"]);
    expect(registry.get("wiki")?.auth?.env).toBe("OKF_GIT_TOKEN");
  });

  it("rejects an auth block that is not an env-var name", async () => {
    const path = join(dir, "bad-auth.json");
    await writeFile(
      path,
      JSON.stringify({ wiki: { kind: "git", location: "x", auth: "ghp_secret" } }),
    );
    await expect(loadRegistry(path)).rejects.toThrow(/never a credential/);
  });

  it("rejects entries missing kind or location", async () => {
    const path = join(dir, "bad-entry.json");
    await writeFile(path, JSON.stringify({ wiki: { location: "x" } }));
    await expect(loadRegistry(path)).rejects.toThrow(/missing "kind"/);
  });
});

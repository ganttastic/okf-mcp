import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRegistry, gitBundleName, parseCliOptions } from "../src/config.js";

describe("CLI option parsing", () => {
  it("collects multi-value flags until the next flag", () => {
    const options = parseCliOptions([
      "--local",
      "/a/wiki-one",
      "/b/wiki-two",
      "--git",
      "https://example.com/repo.git#main",
      "--sources",
      "custom.json",
    ]);
    expect(options.localDirs).toEqual(["/a/wiki-one", "/b/wiki-two"]);
    expect(options.gitUrls).toEqual(["https://example.com/repo.git#main"]);
    expect(options.sourcesPath).toBe("custom.json");
  });

  it("accepts bare flags with no values (empty form fields)", () => {
    const options = parseCliOptions(["--local", "--git"]);
    expect(options.localDirs).toEqual([]);
    expect(options.gitUrls).toEqual([]);
  });

  it("rejects unknown options and stray arguments", () => {
    expect(() => parseCliOptions(["--nope"])).toThrow(/Unknown option/);
    expect(() => parseCliOptions(["stray"])).toThrow(/Unexpected argument/);
  });
});

describe("registry building", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "okf-mcp-config-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("derives bundle names from directory and repository basenames", async () => {
    const registry = await buildRegistry(
      {
        localDirs: ["/somewhere/dash-wiki"],
        gitUrls: ["https://github.com/Acme/acme-wiki.git#main"],
      },
      {},
      dir,
    );
    expect(registry.get("dash-wiki")).toEqual({
      kind: "filesystem",
      location: "/somewhere/dash-wiki",
    });
    expect(registry.get("acme-wiki")).toEqual({
      kind: "git",
      location: "https://github.com/Acme/acme-wiki.git#main",
    });
  });

  it("attaches auth only when the token env var is set", async () => {
    const registry = await buildRegistry(
      { localDirs: [], gitUrls: ["https://example.com/wiki.git"] },
      { OKF_GIT_TOKEN: "tok" },
      dir,
    );
    expect(registry.get("wiki")?.auth).toEqual({ env: "OKF_GIT_TOKEN" });
  });

  it("merges an explicit sources.json with flag-derived bundles", async () => {
    const path = join(dir, "explicit-sources.json");
    await writeFile(
      path,
      JSON.stringify({ curated: { kind: "filesystem", location: "/x/curated" } }),
    );
    const registry = await buildRegistry(
      { sourcesPath: path, localDirs: ["/y/extra"], gitUrls: [] },
      {},
      dir,
    );
    expect([...registry.keys()]).toEqual(["curated", "extra"]);
  });

  it("reads bundle lists from env vars and suffixes name collisions", async () => {
    const registry = await buildRegistry(
      { localDirs: ["/a/wiki"], gitUrls: [] },
      { OKF_MCP_LOCAL_BUNDLES: "/b/wiki, /c/other" },
      dir,
    );
    expect([...registry.keys()].sort()).toEqual(["other", "wiki", "wiki-2"]);
  });

  it("ignores empty values and unexpanded config placeholders", async () => {
    const registry = await buildRegistry(
      { localDirs: ["${user_config.local_bundles}", "/real/wiki"], gitUrls: [""] },
      {},
      dir,
    );
    expect([...registry.keys()]).toEqual(["wiki"]);
  });

  it("errors when nothing is configured, saying how to configure", async () => {
    await expect(
      buildRegistry({ localDirs: [], gitUrls: [] }, {}, dir),
    ).rejects.toThrow(/No bundles configured/);
  });
});

describe("git bundle naming", () => {
  it("strips branch, .git suffix, and trailing slashes", () => {
    expect(gitBundleName("https://github.com/DashAuction/dash-wiki.git#main")).toBe("dash-wiki");
    expect(gitBundleName("git@github.com:org/repo.git")).toBe("repo");
    expect(gitBundleName("https://example.com/wiki/")).toBe("wiki");
  });
});

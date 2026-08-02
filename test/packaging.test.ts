import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const INJECTOR = fileURLToPath(new URL("../scripts/inject-defaults.mjs", import.meta.url));
const MANIFEST = fileURLToPath(new URL("../manifest.json", import.meta.url));

describe("installer default injection", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "okf-mcp-pack-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("bakes git/local defaults and identity into the manifest", async () => {
    const staged = join(dir, "manifest.json");
    await copyFile(MANIFEST, staged);
    await execFileAsync("node", [
      INJECTOR,
      staged,
      "--name",
      "okf-dash",
      "--display-name",
      "DASH Wiki",
      "--git",
      "https://github.com/DashAuction/dash-wiki.git#main",
      "--local",
      "/data/scratch-wiki",
    ]);
    const manifest = JSON.parse(await readFile(staged, "utf8"));
    expect(manifest.name).toBe("okf-dash");
    expect(manifest.display_name).toBe("DASH Wiki");
    expect(manifest.user_config.git_bundles.default).toEqual([
      "https://github.com/DashAuction/dash-wiki.git#main",
    ]);
    expect(manifest.user_config.local_bundles.default).toEqual(["/data/scratch-wiki"]);
  });

  it("leaves the manifest untouched when no defaults are given", async () => {
    const staged = join(dir, "untouched.json");
    await copyFile(MANIFEST, staged);
    await execFileAsync("node", [INJECTOR, staged]);
    const manifest = JSON.parse(await readFile(staged, "utf8"));
    const original = JSON.parse(await readFile(MANIFEST, "utf8"));
    expect(manifest).toEqual(original);
  });

  it("rejects unknown options", async () => {
    const staged = join(dir, "reject.json");
    await copyFile(MANIFEST, staged);
    await expect(execFileAsync("node", [INJECTOR, staged, "--nope"])).rejects.toThrow();
  });
});

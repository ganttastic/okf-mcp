import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const INJECTOR = fileURLToPath(new URL("../scripts/inject-defaults.mjs", import.meta.url));
const MANIFEST = fileURLToPath(new URL("../manifest.json", import.meta.url));
const KEY_INSTALLER_GEN = fileURLToPath(
  new URL("../scripts/make-key-installer.sh", import.meta.url),
);

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

describe("deploy key installer", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "okf-mcp-keygen-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("generates a double-clickable installer that places the key with 600 perms", async () => {
    const keySource = join(dir, "deploy-key");
    const keyBody = "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-key-material\n-----END OPENSSH PRIVATE KEY-----\n";
    await writeFile(keySource, keyBody);
    const installer = join(dir, "Install Key.command");
    await execFileAsync("bash", [KEY_INSTALLER_GEN, keySource, installer]);

    // Run it exactly as a recipient's double-click would, in a sandbox HOME.
    const home = join(dir, "home");
    await execFileAsync("sh", [installer], { env: { ...process.env, HOME: home } });

    const installed = join(home, ".config", "okf-mcp", "deploy-key");
    expect(await readFile(installed, "utf8")).toBe(keyBody);
    expect((await stat(installed)).mode & 0o777).toBe(0o600);
    // Running it again (double-click twice) must be harmless.
    await execFileAsync("sh", [installer], { env: { ...process.env, HOME: home } });
    expect(await readFile(installed, "utf8")).toBe(keyBody);
  });

  it("refuses a file that is not a private key", async () => {
    const notAKey = join(dir, "notes.txt");
    await writeFile(notAKey, "hello");
    await expect(
      execFileAsync("bash", [KEY_INSTALLER_GEN, notAKey, join(dir, "out.command")]),
    ).rejects.toThrow();
  });
});

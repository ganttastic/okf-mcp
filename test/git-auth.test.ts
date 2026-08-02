import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkSshKey, gitEnv, isSshRemote, resolveSshKeyPath, withAuth } from "../src/connectors/git.js";
import type { SourceConfig } from "../src/connectors/types.js";

const authed = (location: string): SourceConfig => ({
  kind: "git",
  location,
  auth: { env: "OKF_GIT_TOKEN" },
});

describe("token auth (HTTPS)", () => {
  it("injects the token into https URLs without persisting it anywhere", () => {
    process.env["OKF_GIT_TOKEN"] = "tok123";
    try {
      const url = withAuth("https://github.com/org/wiki.git", authed("…"), "wiki");
      expect(url).toBe("https://x-access-token:tok123@github.com/org/wiki.git");
    } finally {
      delete process.env["OKF_GIT_TOKEN"];
    }
  });

  it("leaves SSH remotes alone — keys authenticate those, not tokens", () => {
    expect(withAuth("git@github.com:org/wiki.git", authed("…"), "wiki")).toBe(
      "git@github.com:org/wiki.git",
    );
    expect(withAuth("ssh://git@github.com/org/wiki.git", authed("…"), "wiki")).toBe(
      "ssh://git@github.com/org/wiki.git",
    );
  });
});

// A path that never exists, so tests are hermetic even on machines that
// have a real key installed at the standard location.
const NO_DEFAULT_KEY = "/nonexistent/okf-mcp/deploy-key";

describe("deploy key auth (SSH)", () => {
  it("routes git through the named key file", () => {
    const env = gitEnv({ OKF_GIT_SSH_KEY: "/keys/deploy key" }, NO_DEFAULT_KEY);
    expect(env["GIT_SSH_COMMAND"]).toBe(
      'ssh -i "/keys/deploy key" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new',
    );
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
  });

  it("ignores empty values and unexpanded config placeholders", () => {
    expect(gitEnv({ OKF_GIT_SSH_KEY: "" }, NO_DEFAULT_KEY)["GIT_SSH_COMMAND"]).toBeUndefined();
    expect(
      gitEnv({ OKF_GIT_SSH_KEY: "${user_config.ssh_key}" }, NO_DEFAULT_KEY)["GIT_SSH_COMMAND"],
    ).toBeUndefined();
    expect(gitEnv({}, NO_DEFAULT_KEY)["GIT_SSH_COMMAND"]).toBeUndefined();
  });

  it("falls back to an installed key at the standard location", async () => {
    const dir = await mkdtemp(join(tmpdir(), "okf-mcp-default-key-"));
    const installed = join(dir, "deploy-key");
    try {
      await writeFile(installed, "key");
      expect(resolveSshKeyPath({}, installed)).toBe(installed);
      expect(gitEnv({}, installed)["GIT_SSH_COMMAND"]).toContain(`-i "${installed}"`);
      // An explicitly configured key still wins over the installed one.
      expect(resolveSshKeyPath({ OKF_GIT_SSH_KEY: "/explicit" }, installed)).toBe("/explicit");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("classifies remotes: keys apply to ssh, not https or local paths", () => {
    expect(isSshRemote("git@github.com:org/wiki.git")).toBe(true);
    expect(isSshRemote("ssh://git@github.com/org/wiki.git")).toBe(true);
    expect(isSshRemote("https://github.com/org/wiki.git")).toBe(false);
    expect(isSshRemote("/tmp/origin")).toBe(false);
    expect(isSshRemote("~/Repositories/wiki")).toBe(false);
  });
});

describe("deploy key preflight", () => {
  let dir: string;
  let keyPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "okf-mcp-key-"));
    keyPath = join(dir, "deploy-key");
    await writeFile(keyPath, "-----BEGIN OPENSSH PRIVATE KEY-----\n…\n");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects a key saved with open permissions, naming the fix", async () => {
    await chmod(keyPath, 0o644);
    await expect(checkSshKey({ OKF_GIT_SSH_KEY: keyPath }, NO_DEFAULT_KEY)).rejects.toThrow(/chmod 600/);
  });

  it("accepts a properly protected key", async () => {
    await chmod(keyPath, 0o600);
    await expect(checkSshKey({ OKF_GIT_SSH_KEY: keyPath }, NO_DEFAULT_KEY)).resolves.toBeUndefined();
  });

  it("rejects a missing key file by its configured path", async () => {
    await expect(checkSshKey({ OKF_GIT_SSH_KEY: join(dir, "nope") }, NO_DEFAULT_KEY)).rejects.toThrow(
      /SSH key not found/,
    );
  });

  it("is a no-op when no key is configured", async () => {
    await expect(checkSshKey({}, NO_DEFAULT_KEY)).resolves.toBeUndefined();
    await expect(checkSshKey({ OKF_GIT_SSH_KEY: "${user_config.ssh_key}" }, NO_DEFAULT_KEY)).resolves.toBeUndefined();
  });
});

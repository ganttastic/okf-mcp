import { describe, expect, it } from "vitest";
import { gitEnv, withAuth } from "../src/connectors/git.js";
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

describe("deploy key auth (SSH)", () => {
  it("routes git through the named key file", () => {
    const env = gitEnv({ OKF_GIT_SSH_KEY: "/keys/deploy key" });
    expect(env["GIT_SSH_COMMAND"]).toBe(
      'ssh -i "/keys/deploy key" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new',
    );
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
  });

  it("ignores empty values and unexpanded config placeholders", () => {
    expect(gitEnv({ OKF_GIT_SSH_KEY: "" })["GIT_SSH_COMMAND"]).toBeUndefined();
    expect(gitEnv({ OKF_GIT_SSH_KEY: "${user_config.ssh_key}" })["GIT_SSH_COMMAND"]).toBeUndefined();
    expect(gitEnv({})["GIT_SSH_COMMAND"]).toBeUndefined();
  });
});

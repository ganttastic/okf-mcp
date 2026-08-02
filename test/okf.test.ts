import { describe, expect, it } from "vitest";
import { deriveSignals, normalizeVerified, trustTier } from "../src/okf.js";

describe("verified normalization (§11)", () => {
  it("treats a bare mapping as a one-element list", () => {
    expect(normalizeVerified({ by: "human:ryan", at: "2026-01-01T00:00:00Z" })).toEqual([
      { by: "human:ryan", at: "2026-01-01T00:00:00Z" },
    ]);
  });

  it("passes lists through and drops malformed entries", () => {
    expect(
      normalizeVerified([
        { by: "process:nightly" },
        { at: "2026-01-01" }, // no actor — dropped
        "not a mapping",
        null,
      ]),
    ).toEqual([{ by: "process:nightly", at: undefined }]);
  });

  it("returns empty for absent values", () => {
    expect(normalizeVerified(undefined)).toEqual([]);
    expect(normalizeVerified(null)).toEqual([]);
  });
});

describe("trust tiers (§5.3)", () => {
  it("no verification → unverified", () => {
    expect(trustTier([])).toBe("unverified");
  });

  it("only non-human actors → machine-confirmed", () => {
    expect(trustTier([{ by: "reference_agent/gemini-2.5-pro" }, { by: "process:nightly" }])).toBe(
      "machine-confirmed",
    );
  });

  it("any human: actor → human-reviewed", () => {
    expect(trustTier([{ by: "process:nightly" }, { by: "human:ryan" }])).toBe("human-reviewed");
  });
});

describe("derived signals", () => {
  it("defaults status to stable and title to the filename (§4, §5.4)", () => {
    const signals = deriveSignals("business/buyers-premium.md", { type: "Concept" });
    expect(signals.status).toBe("stable");
    expect(signals.title).toBe("buyers-premium");
    expect(signals.trust_tier).toBe("unverified");
    expect(signals.stale).toBe(false);
  });

  it("computes staleness from stale_after (§5.5)", () => {
    const fm = { type: "Metric", stale_after: "2026-06-01" };
    expect(deriveSignals("m.md", fm, "2026-05-31").stale).toBe(false);
    expect(deriveSignals("m.md", fm, "2026-06-01").stale).toBe(true); // today >= date
    expect(deriveSignals("m.md", fm, "2026-07-01").stale).toBe(true);
  });

  it("prefers generated.at, falling back to the v0.1 timestamp (§13)", () => {
    expect(
      deriveSignals("c.md", {
        generated: { by: "process:pipeline", at: "2026-02-02T00:00:00Z" },
        timestamp: "2020-01-01T00:00:00Z",
      }).generated_at,
    ).toBe("2026-02-02T00:00:00Z");
    expect(
      deriveSignals("c.md", { timestamp: "2020-01-01T00:00:00Z" }).generated_at,
    ).toBe("2020-01-01T00:00:00Z");
    expect(
      deriveSignals("c.md", {
        generated: { by: "process:pipeline", at: "2026-02-02T00:00:00Z" },
      }).generated_by,
    ).toBe("process:pipeline");
  });
});

/**
 * Consumer-side rules of OKF v0.2 that derive signals from frontmatter:
 * trust tiers (§5.3), lifecycle (§5.4–5.5), the actor convention (§7), and
 * the v0.1 `timestamp` fallback (§13). Nothing here is stored — the spec is
 * explicit that tiers and staleness are derived, not written back.
 */

export interface VerifiedEntry {
  by: string;
  at?: string;
}

export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";

export interface OkfSignals {
  type?: string;
  title: string;
  description?: string;
  status: string; // "draft" | "stable" | "deprecated"; absent → "stable" (§5.4)
  trust_tier: TrustTier;
  verified: VerifiedEntry[];
  generated_by?: string;
  generated_at?: string;
  stale: boolean;
  stale_after?: string;
  tags?: unknown[];
}

/** A bare `verified` mapping MUST be treated as a one-element list (§11). */
export function normalizeVerified(value: unknown): VerifiedEntry[] {
  if (value === null || value === undefined) return [];
  const entries = Array.isArray(value) ? value : [value];
  const result: VerifiedEntry[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record["by"] !== "string" || record["by"] === "") continue;
    result.push({
      by: record["by"],
      at: typeof record["at"] === "string" ? record["at"] : undefined,
    });
  }
  return result;
}

/** Consumers key trust classification off the `human:` prefix (§5.3, §7). */
export function trustTier(verified: VerifiedEntry[]): TrustTier {
  if (verified.length === 0) return "unverified";
  return verified.some((v) => v.by.startsWith("human:")) ? "human-reviewed" : "machine-confirmed";
}

export function deriveSignals(
  path: string,
  frontmatter: Record<string, unknown>,
  today: string = new Date().toISOString().slice(0, 10),
): OkfSignals {
  const verified = normalizeVerified(frontmatter["verified"]);

  const generated =
    frontmatter["generated"] !== null && typeof frontmatter["generated"] === "object"
      ? (frontmatter["generated"] as Record<string, unknown>)
      : undefined;
  // v0.1 bundles carry `timestamp`; v0.2 renamed it to generated.at (§13).
  const legacyTimestamp = frontmatter["timestamp"];
  const generatedAt =
    typeof generated?.["at"] === "string"
      ? generated["at"]
      : typeof legacyTimestamp === "string"
        ? legacyTimestamp
        : undefined;

  const staleAfter =
    typeof frontmatter["stale_after"] === "string" ? frontmatter["stale_after"] : undefined;

  const filename = path.split("/").pop() ?? path;
  const title =
    typeof frontmatter["title"] === "string"
      ? frontmatter["title"]
      : filename.replace(/\.md$/, ""); // title derives from filename when omitted (§4)

  return {
    type: typeof frontmatter["type"] === "string" ? frontmatter["type"] : undefined,
    title,
    description:
      typeof frontmatter["description"] === "string" ? frontmatter["description"] : undefined,
    status: typeof frontmatter["status"] === "string" ? frontmatter["status"] : "stable",
    trust_tier: trustTier(verified),
    verified,
    generated_by: typeof generated?.["by"] === "string" ? generated["by"] : undefined,
    generated_at: generatedAt,
    stale: staleAfter !== undefined && today >= staleAfter,
    stale_after: staleAfter,
    tags: Array.isArray(frontmatter["tags"]) ? frontmatter["tags"] : undefined,
  };
}

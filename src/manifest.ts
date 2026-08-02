import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import type { OkfManifest } from "./connectors/types.js";

export interface LoadedManifest {
  manifest: OkfManifest;
  synthesized: boolean;
}

/**
 * okf.json is authoritative when present, synthesized when absent (§3).
 * A bundle that predates the manifest is still a bundle.
 */
export async function loadOrSynthesizeManifest(rootDir: string): Promise<LoadedManifest> {
  let raw: string;
  try {
    raw = await readFile(join(rootDir, "okf.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { manifest: await synthesizeManifest(rootDir), synthesized: true };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`okf.json in ${rootDir} is not valid JSON: ${(err as Error).message}`);
  }
  return { manifest: validateManifest(parsed, rootDir), synthesized: false };
}

/**
 * Synthesize a manifest for a bundle without okf.json: okf_version comes from
 * the root index's frontmatter, categories are the top-level directories that
 * carry an index.md of their own.
 */
export async function synthesizeManifest(rootDir: string): Promise<OkfManifest> {
  let indexRaw: string;
  try {
    indexRaw = await readFile(join(rootDir, "index.md"), "utf8");
  } catch {
    // Absence is not a bundle — resolveBundle callers rely on this throwing.
    throw new Error(`${rootDir} is not an OKF bundle: no okf.json and no root index.md`);
  }

  const { frontmatter } = parseFrontmatter(indexRaw);
  const okfVersion = frontmatter["okf_version"];
  if (typeof okfVersion !== "string" && typeof okfVersion !== "number") {
    throw new Error(
      `${rootDir} is not an OKF bundle: root index.md frontmatter has no okf_version`,
    );
  }

  const entries = await readdir(rootDir, { withFileTypes: true });
  const categories: { path: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      await readFile(join(rootDir, entry.name, "index.md"), "utf8");
      categories.push({ path: entry.name });
    } catch {
      // no index.md — not a category
    }
  }
  categories.sort((a, b) => a.path.localeCompare(b.path));

  return {
    okf_version: String(okfVersion),
    root: "index.md",
    categories,
  };
}

function validateManifest(parsed: unknown, rootDir: string): OkfManifest {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`okf.json in ${rootDir} must be a JSON object`);
  }
  const m = parsed as Record<string, unknown>;
  if (typeof m["okf_version"] !== "string") {
    throw new Error(`okf.json in ${rootDir} is missing "okf_version"`);
  }
  if (typeof m["root"] !== "string") {
    throw new Error(`okf.json in ${rootDir} is missing "root"`);
  }
  if (!Array.isArray(m["categories"])) {
    throw new Error(`okf.json in ${rootDir} is missing "categories"`);
  }
  for (const category of m["categories"]) {
    if (category === null || typeof category !== "object" || typeof category.path !== "string") {
      throw new Error(`okf.json in ${rootDir}: every category needs a "path"`);
    }
  }
  // Unknown keys ride along untouched — the cast keeps them.
  return m as unknown as OkfManifest;
}

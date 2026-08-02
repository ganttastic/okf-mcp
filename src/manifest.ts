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
 * Synthesize a manifest for a bundle without okf.json. OKF is lenient by
 * design: index.md is optional everywhere (§8), and declaring okf_version in
 * the root index is a MAY (§12) — consumers attempt best-effort consumption
 * rather than refuse the bundle. So a bundle here is any directory holding
 * markdown at its top level or in an immediate subdirectory; only a
 * directory with no markdown at all is rejected.
 */
export async function synthesizeManifest(rootDir: string): Promise<OkfManifest> {
  let okfVersion: string | undefined;
  try {
    const { frontmatter } = parseFrontmatter(await readFile(join(rootDir, "index.md"), "utf8"));
    const declared = frontmatter["okf_version"];
    if (typeof declared === "string" || typeof declared === "number") {
      okfVersion = String(declared);
    }
  } catch {
    // no root index — synthesized on read (§8)
  }

  const entries = await readdir(rootDir, { withFileTypes: true });
  let hasRootMarkdown = false;
  const categories: { path: string }[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isFile() && entry.name.endsWith(".md")) {
      hasRootMarkdown = true;
    } else if (entry.isDirectory()) {
      const children = await readdir(join(rootDir, entry.name), { withFileTypes: true });
      if (children.some((child) => child.isFile() && child.name.endsWith(".md"))) {
        categories.push({ path: entry.name });
      }
    }
  }
  categories.sort((a, b) => a.path.localeCompare(b.path));

  if (!hasRootMarkdown && categories.length === 0) {
    // Absence is not a bundle — resolveBundle callers rely on this throwing.
    throw new Error(`${rootDir} is not an OKF bundle: no okf.json and no markdown content`);
  }

  return {
    okf_version: okfVersion ?? "unspecified",
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

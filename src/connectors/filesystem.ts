import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseFrontmatter } from "../frontmatter.js";
import { loadOrSynthesizeManifest } from "../manifest.js";
import type {
  BundleHandle,
  Concept,
  OkfConnector,
  SearchHit,
  SourceConfig,
} from "./types.js";

const MAX_SEARCH_HITS = 50;

/**
 * Plain-directory reads — the shared read path (§7). The git connector serves
 * every read through this code from its working tree.
 */
export class FilesystemConnector implements OkfConnector {
  readonly kind: string = "filesystem";
  readonly capabilities = { search: true };

  async resolveBundle(name: string, source: SourceConfig): Promise<BundleHandle> {
    const rootDir = resolve(expandTilde(source.location));
    let stats;
    try {
      stats = await stat(rootDir);
    } catch {
      throw new Error(`Bundle "${name}": ${rootDir} does not exist`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`Bundle "${name}": ${rootDir} is not a directory`);
    }
    return this.resolveAt(name, source, rootDir);
  }

  /** Build a handle over an already-materialized working tree. */
  async resolveAt(name: string, source: SourceConfig, rootDir: string): Promise<BundleHandle> {
    const { manifest, synthesized } = await loadOrSynthesizeManifest(rootDir);
    return { name, source, manifest, manifestSynthesized: synthesized, rootDir };
  }

  async readIndex(bundle: BundleHandle, directory?: string): Promise<string> {
    const path = directory ? join(directory, "index.md") : bundle.manifest.root;
    return this.readVerbatim(bundle, path);
  }

  async readConcept(bundle: BundleHandle, path: string): Promise<Concept> {
    const raw = await this.readVerbatim(bundle, path);
    const { frontmatter, body } = parseFrontmatter(raw);
    return { path, frontmatter, body, raw };
  }

  async listDirectories(bundle: BundleHandle): Promise<string[]> {
    const machinery = new Set(bundle.manifest.machinery ?? []);
    const entries = await readdir(bundle.rootDir, { withFileTypes: true });
    const directories: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || machinery.has(entry.name)) {
        continue;
      }
      try {
        await stat(join(bundle.rootDir, entry.name, "index.md"));
        directories.push(entry.name);
      } catch {
        // no index.md — not part of the knowledge surface
      }
    }
    return directories.sort();
  }

  async search(bundle: BundleHandle, query: string): Promise<SearchHit[]> {
    const needle = query.toLowerCase();
    const machinery = new Set(bundle.manifest.machinery ?? []);
    const hits: SearchHit[] = [];
    await this.searchDir(bundle.rootDir, "", machinery, needle, hits);
    return hits;
  }

  private async searchDir(
    rootDir: string,
    relDir: string,
    machinery: Set<string>,
    needle: string,
    hits: SearchHit[],
  ): Promise<void> {
    if (hits.length >= MAX_SEARCH_HITS) return;
    const entries = await readdir(join(rootDir, relDir), { withFileTypes: true });
    for (const entry of entries) {
      if (hits.length >= MAX_SEARCH_HITS) return;
      const relPath = relDir ? join(relDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || machinery.has(relPath)) {
          continue;
        }
        await this.searchDir(rootDir, relPath, machinery, needle, hits);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const content = await readFile(join(rootDir, relPath), "utf8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(needle)) {
            hits.push({ path: relPath, line: i + 1, snippet: lines[i].trim() });
            if (hits.length >= MAX_SEARCH_HITS) return;
          }
        }
      }
    }
  }

  /**
   * Reads are verbatim bytes — no whitespace normalization, no line-ending
   * translation, no trailing-newline adjustment. Consumers that later diff or
   * edit against these reads depend on this.
   */
  private async readVerbatim(bundle: BundleHandle, path: string): Promise<string> {
    const full = resolve(bundle.rootDir, path);
    const rel = relative(bundle.rootDir, full);
    if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes(".git")) {
      throw new Error(`Path "${path}" escapes bundle "${bundle.name}"`);
    }
    try {
      return await readFile(full, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Bundle "${bundle.name}" has no file at "${path}"`);
      }
      throw err;
    }
  }
}

export function expandTilde(location: string): string {
  if (location === "~") return homedir();
  if (location.startsWith("~/")) return join(homedir(), location.slice(2));
  return location;
}

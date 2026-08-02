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
    try {
      return await this.readVerbatim(bundle, path);
    } catch (err) {
      // index.md is optional everywhere (OKF §8); consumers MAY synthesize
      // a listing on the fly rather than reject the directory (§11).
      if ((err as { notFound?: boolean }).notFound) {
        return this.synthesizeIndex(bundle, directory);
      }
      throw err;
    }
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
      // A directory belongs to the knowledge surface if it holds any
      // markdown — index.md is optional (OKF §8, §11).
      if (await containsMarkdown(join(bundle.rootDir, entry.name))) {
        directories.push(entry.name);
      }
    }
    return directories.sort();
  }

  /**
   * A directory listing in the §8 index shape, built from frontmatter:
   * `* [Title](path) - description`, titles falling back to filenames.
   */
  private async synthesizeIndex(bundle: BundleHandle, directory?: string): Promise<string> {
    const machinery = new Set(directory ? [] : (bundle.manifest.machinery ?? []));
    const dirPath = directory ? join(bundle.rootDir, directory) : bundle.rootDir;
    const heading = directory ?? bundle.manifest.title ?? bundle.name;
    const entries = await readdir(dirPath, { withFileTypes: true });

    const lines: string[] = [`# ${heading}`, ""];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || machinery.has(entry.name)) continue;
      if (entry.isDirectory()) {
        if (await containsMarkdown(join(dirPath, entry.name))) {
          lines.push(`* [${entry.name}/](${entry.name}/)`);
        }
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        entry.name !== "index.md" &&
        entry.name !== "log.md" // reserved names are not concepts (OKF §3)
      ) {
        const relPath = directory ? join(directory, entry.name) : entry.name;
        const { frontmatter } = parseFrontmatter(await readFile(join(dirPath, entry.name), "utf8"));
        const title =
          typeof frontmatter["title"] === "string"
            ? frontmatter["title"]
            : entry.name.replace(/\.md$/, "");
        const description =
          typeof frontmatter["description"] === "string" ? ` - ${frontmatter["description"]}` : "";
        lines.push(`* [${title}](${relPath})${description}`);
      }
    }
    return lines.join("\n") + "\n";
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
        const notFound = new Error(`Bundle "${bundle.name}" has no file at "${path}"`);
        (notFound as Error & { notFound: boolean }).notFound = true;
        throw notFound;
      }
      throw err;
    }
  }
}

/** Does the directory hold any markdown at its top level? */
async function containsMarkdown(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && entry.name.endsWith(".md"));
  } catch {
    return false;
  }
}

export function expandTilde(location: string): string {
  if (location === "~") return homedir();
  if (location.startsWith("~/")) return join(homedir(), location.slice(2));
  return location;
}

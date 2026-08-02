/**
 * The connector interface (design sketch §4). A connector knows how to reach
 * one kind of source — a git remote, a local directory — and nothing about
 * what the tools do with the content.
 */

export interface SourceConfig {
  kind: string; // "git" | "filesystem" | …
  location: string; // kind-specific: a clone URL + "#branch", "/path/to/bundle"
  auth?: { env: string }; // NAME of the env var holding the credential — never the value
  maxStalenessMinutes?: number; // git kind: pull before serving reads older than this
}

export interface OkfCategory {
  path: string;
  answers?: string;
  [key: string]: unknown;
}

/** Parsed okf.json, or synthesized from the root index when the file is absent (§3). */
export interface OkfManifest {
  okf_version: string;
  name?: string;
  title?: string;
  description?: string;
  root: string; // root index, e.g. "index.md"
  log?: string;
  agents_guide?: string;
  categories: OkfCategory[];
  machinery?: string[];
  conventions?: Record<string, unknown>;
  [key: string]: unknown; // unknown keys preserved
}

export interface BundleHandle {
  name: string; // registry key, e.g. "dash-wiki"
  source: SourceConfig;
  manifest: OkfManifest;
  manifestSynthesized: boolean;
  /** Absolute path of the working tree serving reads. */
  rootDir: string;
  /** Last successful sync, for kinds that mirror a remote. */
  syncedAt?: string;
  /** Set when the last pull failed and reads are served from an aging tree. */
  stale?: boolean;
}

export interface Concept {
  path: string; // "business/buyers-premium.md"
  frontmatter: Record<string, unknown>; // unknown keys preserved (OKF §4.1)
  body: string;
  raw: string; // exact bytes as stored — no normalization anywhere
}

export interface SearchHit {
  path: string;
  line: number; // 1-based
  snippet: string;
}

export interface OkfConnector {
  readonly kind: string;
  readonly capabilities: { search: boolean };

  /** Throws on failure — a failed fetch is not an empty bundle. */
  resolveBundle(name: string, source: SourceConfig): Promise<BundleHandle>;
  readIndex(bundle: BundleHandle, directory?: string): Promise<string>;
  readConcept(bundle: BundleHandle, path: string): Promise<Concept>;
  listDirectories(bundle: BundleHandle): Promise<string[]>;
  /** Bring a mirrored source up to date; no-op for purely local kinds. */
  refresh?(bundle: BundleHandle): Promise<void>;
  search?(bundle: BundleHandle, query: string): Promise<SearchHit[]>;
}

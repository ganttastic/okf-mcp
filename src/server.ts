#!/usr/bin/env node
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { buildRegistry, parseCliOptions } from "./config.js";
import { deriveSignals } from "./okf.js";
import { z } from "zod";
import { FilesystemConnector } from "./connectors/filesystem.js";
import { GitConnector } from "./connectors/git.js";
import type { BundleHandle, OkfConnector, SearchHit, SourceConfig } from "./connectors/types.js";

interface ServerContext {
  registry: Map<string, SourceConfig>;
  connectors: Map<string, OkfConnector>;
  /** Bundles resolve lazily on first use, so listing never forces a clone. */
  handles: Map<string, BundleHandle>;
}

export function createServer(context: ServerContext): McpServer {
  const server = new McpServer({ name: "okf-mcp", version: "0.1.0" });

  const getBundle = async (name?: string): Promise<{ handle: BundleHandle; connector: OkfConnector }> => {
    // A dedicated single-corpus deployment shouldn't have to repeat the
    // bundle name on every call; a hub fronting several must be explicit.
    if (name === undefined) {
      if (context.registry.size !== 1) {
        const known = [...context.registry.keys()].join(", ");
        throw new Error(
          `This server fronts ${context.registry.size} bundles, so "bundle" is required. Registered bundles: ${known}`,
        );
      }
      name = context.registry.keys().next().value as string;
    }
    const source = context.registry.get(name);
    if (!source) {
      const known = [...context.registry.keys()].join(", ");
      throw new Error(`Unknown bundle "${name}". Registered bundles: ${known}`);
    }
    const connector = context.connectors.get(source.kind);
    if (!connector) {
      throw new Error(`Bundle "${name}" has unsupported source kind "${source.kind}"`);
    }
    let handle = context.handles.get(name);
    if (!handle) {
      handle = await connector.resolveBundle(name, source);
      context.handles.set(name, handle);
    }
    return { handle, connector };
  };

  const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

  const bundleParam = z
    .string()
    .optional()
    .describe(
      "Bundle name from list_bundles. Optional when this server fronts exactly one bundle.",
    );

  server.registerTool(
    "list_bundles",
    {
      title: "List bundles",
      description:
        "List every OKF bundle this server fronts, with source kind, sync state, and the questions each category answers. Start here to find the right bundle.",
      inputSchema: {},
    },
    async () => {
      const rows = [...context.registry.entries()].map(([name, source]) => {
        const handle = context.handles.get(name);
        return {
          name,
          kind: source.kind,
          okf_version: handle?.manifest.okf_version,
          title: handle?.manifest.title,
          description: handle?.manifest.description,
          categories: handle?.manifest.categories.map((c) => ({
            path: c.path,
            answers: c.answers,
          })),
          syncedAt: handle?.syncedAt,
          stale: handle?.stale ?? false,
          resolved: handle !== undefined,
        };
      });
      return text(JSON.stringify(rows, null, 2));
    },
  );

  server.registerTool(
    "list_directories",
    {
      title: "List directories",
      description: "List the category directories of a bundle (machinery directories excluded).",
      inputSchema: { bundle: bundleParam },
    },
    async ({ bundle }) => {
      const { handle, connector } = await getBundle(bundle);
      return text(JSON.stringify(await connector.listDirectories(handle), null, 2));
    },
  );

  server.registerTool(
    "read_index",
    {
      title: "Read index",
      description:
        "Read a bundle's root index, or a directory's index. The indexes are the designed discovery surface — they answer \"does something like this exist\" in fewer tokens than search. Prefer this before search_concepts.",
      inputSchema: {
        bundle: bundleParam,
        directory: z
          .string()
          .optional()
          .describe("Category directory, e.g. \"business\". Omit for the root index."),
      },
    },
    async ({ bundle, directory }) => {
      const { handle, connector } = await getBundle(bundle);
      return text(await connector.readIndex(handle, directory));
    },
  );

  server.registerTool(
    "read_concept",
    {
      title: "Read concept",
      description:
        "Read one concept file verbatim, e.g. path \"business/buyers-premium.md\". Bytes are exact as stored — safe to diff against.",
      inputSchema: {
        bundle: bundleParam,
        path: z.string().describe("Concept path relative to the bundle root, including .md"),
      },
    },
    async ({ bundle, path }) => {
      const { handle, connector } = await getBundle(bundle);
      const concept = await connector.readConcept(handle, path);
      return text(concept.raw);
    },
  );

  server.registerTool(
    "concept_status",
    {
      title: "Concept status",
      description:
        "Derived OKF trust and lifecycle signals for one concept: trust tier (unverified / machine-confirmed / human-reviewed), who verified and generated it, status (draft/stable/deprecated), and staleness. Use before relying on a concept's claims; read_concept stays verbatim and carries none of this.",
      inputSchema: {
        bundle: bundleParam,
        path: z.string().describe("Concept path relative to the bundle root, including .md"),
      },
    },
    async ({ bundle, path }) => {
      const { handle, connector } = await getBundle(bundle);
      const concept = await connector.readConcept(handle, path);
      return text(JSON.stringify(deriveSignals(path, concept.frontmatter), null, 2));
    },
  );

  server.registerTool(
    "search_concepts",
    {
      title: "Search concepts",
      description:
        "Full-text search across a bundle's markdown. Check the indexes with read_index first — they are the designed discovery surface; search is for when the indexes don't answer.",
      inputSchema: {
        bundle: bundleParam,
        query: z.string().describe("Case-insensitive substring to find"),
      },
    },
    async ({ bundle, query }) => {
      const { handle, connector } = await getBundle(bundle);
      const hits = connector.search
        ? await connector.search(handle, query)
        : await indexScanFallback(handle, connector, query);
      return text(JSON.stringify(hits, null, 2));
    },
  );

  // Each bundle's AGENTS.md is an MCP resource, so a consuming agent can load
  // the traversal and authority rules for the bundle it is actually reading.
  server.registerResource(
    "agents-guide",
    new ResourceTemplate("okf://{bundle}/agents-guide", {
      list: async () => ({
        resources: [...context.registry.keys()].map((name) => ({
          uri: `okf://${name}/agents-guide`,
          name: `${name} agent guide`,
          description: `Traversal and authority rules for the "${name}" bundle`,
          mimeType: "text/markdown",
        })),
      }),
    }),
    {
      title: "Bundle agent guide",
      description: "The AGENTS.md of an OKF bundle: its traversal and authority rules",
    },
    async (uri, { bundle }) => {
      const { handle, connector } = await getBundle(String(bundle));
      const guidePath = handle.manifest.agents_guide ?? "AGENTS.md";
      const concept = await connector.readConcept(handle, guidePath);
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: concept.raw }],
      };
    },
  );

  return server;
}

/** For connector kinds without search: scan the root and category indexes. */
async function indexScanFallback(
  handle: BundleHandle,
  connector: OkfConnector,
  query: string,
): Promise<SearchHit[]> {
  const needle = query.toLowerCase();
  const hits: SearchHit[] = [];
  const targets: (string | undefined)[] = [
    undefined,
    ...handle.manifest.categories.map((c) => c.path),
  ];
  for (const directory of targets) {
    let index: string;
    try {
      index = await connector.readIndex(handle, directory);
    } catch {
      continue;
    }
    const path = directory ? `${directory}/index.md` : handle.manifest.root;
    const lines = index.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        hits.push({ path, line: i + 1, snippet: lines[i].trim() });
      }
    }
  }
  return hits;
}

async function main(): Promise<void> {
  const cli = parseCliOptions(process.argv.slice(2));
  const registry = await buildRegistry(cli, process.env);
  const connectors = new Map<string, OkfConnector>();
  const filesystem = new FilesystemConnector();
  connectors.set(filesystem.kind, filesystem);
  const git = new GitConnector();
  connectors.set(git.kind, git);

  const server = createServer({ registry, connectors, handles: new Map() });
  await server.connect(new StdioServerTransport());
  // stdout carries the MCP protocol; anything human goes to stderr.
  console.error(`okf-mcp serving ${registry.size} bundle(s): ${[...registry.keys()].join(", ")}`);
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

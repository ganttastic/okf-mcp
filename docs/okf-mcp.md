---
type: Reference
title: OKF Connector MCP
description: Design sketch for okf-mcp — one MCP server reading many OKF bundles through pluggable source connectors.
tags: [meta, design, mcp, connectors]
timestamp: 2026-08-02T00:00:00Z
revision: 1
---

# OKF Connector MCP — Design Sketch

**Status:** Draft. This document lives here only until the `okf-mcp` repository exists;
when it does, the document moves there and this copy becomes a link. Keeping a copy in two
places would be exactly the silent-divergence problem decision 1 of
[the ingestion spec](ingestion-pipeline.md) exists to prevent.

---

## 1. Purpose

One MCP server that gives agents read access to any number of OKF bundles, wherever they
live. The server speaks MCP on one side and a small connector interface on the other; a
connector knows how to reach one kind of source — a GitHub repository, a local directory,
eventually a Drive folder — and nothing about what the tools do with the content.

This repository is becoming a template. Every instance stamped from it is another OKF
bundle; the MCP is the one piece of infrastructure they all share. That is why it gets its
own repository rather than a directory here: template clones fork and drift by design,
which is correct for knowledge and per-instance machinery and wrong for shared code. A
connector bug fixed in a template would stay broken in every clone already stamped from it.

## 2. Shape

```
agents (Claude, ChatGPT, anything MCP)
        │
        ▼
   okf-mcp server          one process, one tool surface
        │
        ├── git connector         a local clone, pulled when stale
        ├── filesystem connector  any plain directory already on disk
        └── (later) drive, s3, …
        │
        ▼
   OKF bundles             dash-wiki and everything stamped from its template
```

One hub, many spokes. The server holds a registry of sources; each source resolves to a
bundle through its connector. Tools take a bundle name so one server can front an entire
portfolio of client wikis.

## 3. Discovery: the `okf.json` handshake

A connector pointed at a source needs to answer "is this an OKF bundle, and what is its
shape?" without an LLM in the loop. The bundle root carries
[`okf.json`](../okf.json) for exactly this: version, category list, where the root index
and agent guide live, which directories are machinery, which files are generated.

`okf.json` is this template's extension, not part of OKF v0.1 — so a connector must treat
it as authoritative when present and *synthesize* one when absent: read the root
`index.md`, take `okf_version` from its frontmatter, and enumerate top-level directories
containing an `index.md` as categories. A bundle that predates the manifest is still a
bundle.

## 4. The connector interface

```ts
interface SourceConfig {
  kind: string;              // "git" | "filesystem" | …
  location: string;          // kind-specific: a clone URL + "#branch", "/path/to/bundle"
  auth?: { env: string };    // NAME of the env var holding the credential — never the value
}

interface BundleHandle {
  name: string;              // registry key, e.g. "dash-wiki"
  source: SourceConfig;
  manifest: OkfManifest;     // parsed okf.json, or synthesized (§3)
  syncedAt?: string;         // last successful sync, for kinds that mirror a remote
}

interface Concept {
  path: string;                          // "business/buyers-premium.md"
  frontmatter: Record<string, unknown>;  // unknown keys preserved (OKF §4.1)
  body: string;
  raw: string;                           // exact bytes as stored — see below
}

interface OkfConnector {
  readonly kind: string;
  readonly capabilities: { search: boolean };

  resolveBundle(source: SourceConfig): Promise<BundleHandle>;
  readIndex(bundle: BundleHandle, directory?: string): Promise<string>;
  readConcept(bundle: BundleHandle, path: string): Promise<Concept>;
  listDirectories(bundle: BundleHandle): Promise<string[]>;
  /** Bring a mirrored source up to date; no-op for purely local kinds. */
  refresh?(bundle: BundleHandle): Promise<void>;
  search?(bundle: BundleHandle, query: string): Promise<SearchHit[]>;
}
```

Three rules carry over from the ingestion pipeline, each learned the hard way there:

- **Reads are verbatim bytes.** No whitespace normalization, no line-ending translation,
  no trailing-newline adjustment (ingestion spec §2.1, §13.1). The git connector meets
  this the easiest possible way: it reads files straight out of a working tree, so there
  is no transport layer to mishandle. (The pipeline needed the GraphQL
  `object { text oid }` read to get the same guarantee over an API; a clone gets it for
  free.) Any consumer that later diffs or edits against these reads depends on this.
- **A failed fetch is not an empty bundle.** `resolveBundle` throws on failure; it never
  returns an empty handle. The pipeline once conflated these and an agent, told the bundle
  was empty by a swallowed 403, duplicated concepts written minutes earlier
  (ingestion spec §2.2). The same discipline splits sync failures in two: a failed *pull*
  on an existing clone serves the tree it has, flagged with its age — staleness is a fact
  to report. A failed initial *clone* is an error to throw — absence is not a bundle.
- **The clone dissolves the pipeline's binding constraint.** GitHub code search allows 10
  requests/minute, and that budget shaped the entire ingestion design (§2.2). Searching a
  local clone is a grep with no meter running, so `search_concepts` is always available
  and never rationed. Tool descriptions still steer agents toward `read_index` first — no
  longer because search is scarce, but because the indexes are the designed discovery
  surface and answer "does something like this exist" in fewer tokens. `search` stays an
  optional capability for connector kinds that genuinely cannot provide it.

### 4.1 The git connector: a clone kept fresh

The git connector is the filesystem connector plus a sync policy. It maintains a
single-branch clone under a cache directory (`~/.cache/okf-mcp/<bundle>` by default) and
serves every read from that working tree — the read path is literally the filesystem
connector's code.

Freshness is staleness-driven rather than scheduled. A read checks when the clone last
synced; past the bundle's `maxStaleness` (default five minutes, matching the latency the
ingestion pipeline itself promises), it runs `git pull --ff-only` first. Pulls are
single-flight per bundle, so a burst of reads costs one pull, and nothing runs at all
while the server is idle. An always-on deployment can add a background interval — or a
push webhook (§8) — but lazy pulling is the default because it needs no scheduler and
cannot drift from one. And because reads come straight off the working tree, an external
`git pull` from cron composes with all of this rather than fighting it.

`--ff-only` is load-bearing: the clone is a read-only mirror, so a pull that cannot
fast-forward means something else wrote to the cache directory. The recovery is delete
and re-clone, never merge — a mirror that needs merging has already stopped being one.

The pipeline could not make this choice. n8n Cloud has no filesystem, which is why every
repository read there is an API call (ingestion spec §2.1). okf-mcp runs as an ordinary
process on a real machine, so the constraint that forced API reads simply does not bind —
and with it go the rate budget, the fidelity worry, and a network round-trip on every
read.

## 5. Tool surface

The wiki agent's read-only tools (ingestion spec §6.2) are the proven shape; the MCP
surface is the same four with a bundle parameter, plus enumeration:

| Tool | Maps to |
|---|---|
| `list_bundles()` | the source registry, with each bundle's last-sync time |
| `list_directories(bundle)` | connector `listDirectories` |
| `read_index(bundle, directory?)` | connector `readIndex` |
| `read_concept(bundle, path)` | connector `readConcept` |
| `search_concepts(bundle, query)` | connector `search`, or index-scan fallback |

Read-only, deliberately. Bundles are written by their own pipelines and corrected by
humans in git; a write path through the MCP would bypass both the attribution Action and
the authority ordering, and the ingestion spec's whole §9 exists because that ordering is
what makes human corrections stick.

Each bundle's `AGENTS.md` is exposed as an MCP *resource*, so a consuming agent can load
the traversal and authority rules for the bundle it is actually reading rather than
assuming all bundles behave like this one.

## 6. Source registry

```jsonc
// sources.json — checked in; secrets stay in the environment
{
  "dash-wiki": {
    "kind": "git",
    "location": "https://github.com/DashAuction/dash-wiki.git#main",
    "auth": { "env": "OKF_GIT_TOKEN" },
    "maxStalenessMinutes": 5
  },
  "local-scratch": {
    "kind": "filesystem",
    "location": "~/Repositories/dash-wiki"
  }
}
```

Config names the environment variable that holds a credential; it never holds one. Adding
a client is one registry entry, no code.

## 7. Repository layout (sketch)

```
okf-mcp/
├── src/
│   ├── server.ts          # MCP wiring: tools ↔ connector calls, index prefetch
│   ├── manifest.ts        # okf.json parsing, and synthesis for bundles without one
│   ├── registry.ts        # sources.json loading and validation
│   └── connectors/
│       ├── types.ts       # the interface in §4
│       ├── filesystem.ts  # plain-directory reads — the shared read path
│       └── git.ts         # filesystem reads + the clone/pull sync policy (§4.1)
├── sources.example.json
└── test/                  # connectors run against a fixture bundle checked into test/
```

The fixture bundle matters: every connector is tested against the same miniature bundle
(a root, two categories, one concept with unknown frontmatter keys, one bundle *without*
`okf.json`), so "all connectors behave identically" is asserted rather than hoped.

## 8. Open questions

- **Push-triggered freshness.** The staleness window (minutes) already matches the
  latency the pipeline itself promises, but a GitHub webhook → pull would close it to
  seconds for an always-on deployment. Deferred until someone actually notices the gap.
- **Diskless deployments.** If okf-mcp ever runs somewhere without a filesystem, a
  pure-API GitHub connector (GraphQL `text` + `oid` reads, per the ingestion spec's
  pattern) slots into the same interface. Deferred until such a deployment exists.
- **Cross-bundle search.** "Which client wikis mention X" is a real question for a
  portfolio operator — and the clones make it nearly free, a grep across cache
  directories. Deferred until the single-bundle surface is proven.
- **Upstreaming.** If `okf.json` earns its keep across a few template instances, propose
  it for OKF proper rather than keeping it a private extension.

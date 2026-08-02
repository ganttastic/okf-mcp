# okf-mcp

One MCP server that gives agents read access to any number of OKF bundles, wherever they
live. The server speaks MCP on one side and a small connector interface on the other; a
connector knows how to reach one kind of source — a git remote, a local directory — and
nothing about what the tools do with the content.

The full design rationale is in [docs/okf-mcp.md](docs/okf-mcp.md).

## What is OKF?

The [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
(v0.2) represents knowledge as **a directory of markdown files with YAML frontmatter** —
a *bundle*, distributed as a git repository, a tarball, or a subdirectory of a larger
repo. Every non-reserved `.md` file is a *concept*: one subject, written whole, with its
provenance in frontmatter. The only always-required field is `type`; everything else is
convention, and consumers must tolerate what they don't recognize.

```yaml
---
type: Concept
title: Buyer's premium
description: The percentage added to the hammer price.
generated:                        # who last changed the content, and when (§5.2)
  by: process:ingest-pipeline     # actors: process:<id>, human:<id>, <tool>/<version> (§7)
  at: 2026-07-26T22:56:22Z
verified:                         # independent of generated — who confirmed it (§5.2)
  - by: human:ryan
    at: 2026-08-01T00:00:00Z
sources:                          # what the concept derives from (§5.1)
  - id: fee-schedule
    resource: https://example.com/fee-schedule.pdf
status: stable                    # draft | stable | deprecated (§5.4)
stale_after: 2027-01-01           # trust decays on a date, not silently (§5.5)
---

A percentage added to the hammer price…
```

What makes the format worth building on:

- **Trust is derived, not asserted.** A concept verified by a `human:` actor is
  *human-reviewed*; by machines only, *machine-confirmed*; otherwise *unverified*
  (§5.3). Nobody writes a trust tier into a file — consumers compute it, which is what
  `concept_status` does.
- **Two reserved filenames.** `index.md` is a directory's table of contents (§8) and
  `log.md` its date-grouped history, newest first (§9). Both are optional; consumers may
  synthesize an index on the fly.
- **Producers stay honest, consumers stay lenient.** §11 tells producers what a
  conformant bundle looks like, and simultaneously forbids consumers from rejecting
  bundles over missing options, unknown keys, or broken links. Enforcement is a
  producer-side act — which is why validation here is a separate tool rather than a
  gate in the read path.

okf-mcp sits on the consumer side of that contract, with `validate_bundle` as the
opt-in producer-side check.

## Add to Claude Desktop (with a config form)

Build the desktop bundle and open it:

```bash
npm install && npm run pack:mcpb
open build/okf-mcp.mcpb
```

Claude Desktop shows an install dialog with a **configuration form**: pick local bundle
folders with a native directory picker, paste git clone URLs (optionally `#branch`), and
for private repositories either enter a git token (stored in the OS keychain, never in a
config file) or pick an SSH deploy key file for `git@…` URLs. Settings → Extensions →
OKF Connector reopens the form any time.

### Shipping a preconfigured installer

Pass defaults at pack time and the form comes pre-filled — the recipient double-clicks,
at most drops in a credential, and is done:

```bash
npm run pack:mcpb -- --name okf-dash --display-name "DASH Wiki" \
  --git https://github.com/DashAuction/dash-wiki.git#main
```

That writes `build/okf-dash.mcpb` with the repository already in the form. For a public
repository the install is literally double-click → Install. For a private one the
recipient adds either a fine-grained PAT scoped to that repository (HTTPS URL) or a
deploy key file (SSH URL). Give each client's installer its own `--name` — Claude
Desktop identifies extensions by name, so distinct names can coexist.

To distribute with a read-only deploy key — a **two-double-click install**:

```bash
ssh-keygen -t ed25519 -f deploy-key -N ""       # add deploy-key.pub to the repo, write access off
npm run pack:mcpb -- --name okf-dash --display-name "DASH Wiki" \
  --git git@github.com:org/wiki.git#main
npm run key:installer -- deploy-key             # → "build/Install OKF Deploy Key.command"
```

Send both build outputs. Recipients double-click the `.command` first (it writes the
key to `~/.config/okf-mcp/deploy-key` with the permissions ssh requires — on macOS,
right-click → Open the first time, since it's unsigned), then double-click the `.mcpb`
and hit Install. The server finds a key at that standard location automatically, so
the form needs nothing; its SSH-key picker still overrides it when set. The server
also preflights the key before any sync and fails with the exact fix (`chmod 600`) if
it was placed by hand with open permissions.

One SSH key serves all SSH bundles in an install; deploy keys are per-repository on
GitHub, so multiple private repositories need the PAT route instead.

## Add to Codex

```bash
codex mcp add okf -- node /path/to/okf-mcp/dist/server.js --local ~/Repositories/dash-wiki
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.okf]
command = "node"
args = ["/path/to/okf-mcp/dist/server.js", "--git", "https://github.com/DashAuction/dash-wiki.git#main"]
env = { OKF_GIT_TOKEN = "…" }
```

(Build first with `npm install && npm run build`. The same shape works for Claude Code:
`claude mcp add okf -- node /path/to/okf-mcp/dist/server.js --local <dir>`.)

## Configuring sources

Three equivalent channels, merged in this order:

1. **`sources.json`** — full control, including per-bundle `maxStalenessMinutes` and
   custom names. Copy `sources.example.json`; point at it with `--sources <path>` or
   `OKF_MCP_SOURCES`. A `sources.json` in the working directory is picked up
   automatically. `auth.env` names the environment variable holding a credential;
   config never holds one.
2. **CLI flags** — `--local <dir> [<dir>…]` and `--git <url[#branch]> [<url>…]`.
   Bundle names derive from the directory or repository basename.
3. **Env vars** — `OKF_MCP_LOCAL_BUNDLES` / `OKF_MCP_GIT_BUNDLES` (comma-separated).

Git bundles use `OKF_GIT_TOKEN` when it is set, and clone under `OKF_MCP_CACHE_DIR`
(default: `~/.cache/okf-mcp`).

## Tools

| Tool | Purpose |
|---|---|
| `list_bundles()` | the source registry, with each bundle's last-sync time |
| `list_directories(bundle)` | category directories |
| `read_index(bundle, directory?)` | the designed discovery surface — prefer before search |
| `read_concept(bundle, path)` | one concept, verbatim bytes |
| `concept_status(bundle, path)` | derived OKF signals: trust tier, status, staleness |
| `validate_bundle(bundle)` | producer-side §11 conformance report |
| `search_concepts(bundle, query)` | full-text search across a bundle's markdown |

When the registry holds exactly one bundle, the `bundle` parameter is optional and
defaults to it — so a dedicated single-corpus instance never repeats its own name. A
server fronting several bundles requires it, and the error names the candidates.

Each bundle's `AGENTS.md` is exposed as the MCP resource `okf://{bundle}/agents-guide`.

Read-only, deliberately: bundles are written by their own pipelines and corrected by
humans in git.

## OKF v0.2 support

Section references are to [the spec](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).

### Consuming (always lenient)

- Unknown frontmatter keys and `type` values pass through untouched; reads are verbatim
  bytes.
- `concept_status` derives trust tiers per §5.3 (`unverified` / `machine-confirmed` /
  `human-reviewed`, keyed off `human:` actors), normalizes a bare `verified` mapping to
  a one-element list (§11), applies the `status` default and `stale_after` staleness
  (§5.4–5.5), and falls back to the v0.1 `timestamp` when `generated` is absent (§13).
- Missing `index.md` files never reject a bundle: indexes are synthesized on the fly in
  the §8 shape, and a bundle needs no root index or `okf_version` declaration to be
  served (§11–§12).

### Validating (opt-in enforcement)

The read path tolerates everything §11 permits it to — which means a hand-added file
with broken frontmatter, or an index that grew frontmatter it shouldn't have, sails
through silently. `validate_bundle` is the producer-side counterweight:

- **Errors** are §11 violations: unparseable or missing frontmatter, an empty `type`,
  index files carrying frontmatter beyond the root's `okf_version` (§8), log files with
  frontmatter or non-`## YYYY-MM-DD` headings (§9).
- **Warnings** are SHOULD-level slips in the §5 families: a `sources` entry without its
  required `resource`, `generated` or `verified` without `by`, a `status` outside
  `draft | stable | deprecated`, a malformed `stale_after`.
- Machinery directories named in `okf.json` are skipped; dot-directories always are.

The same checks run from the command line — `okf-mcp --validate <dir>` prints the
report and exits 1 on errors — so a bundle repository can gate every push on
conformance with a two-step workflow:

```yaml
# .github/workflows/validate-bundle.yml
on: [push, pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npx --yes https://github.com/ganttastic/okf-mcp/releases/latest/download/okf-mcp.tgz --validate .
```

The tarball is a prebuilt release artifact — no auth, no clone, no build step. Pin a
version by replacing `latest/download` with `download/vX.Y.Z`. Releases are cut by
pushing a version tag (`git tag v0.1.1 && git push --tags`); each release also carries
the Claude Desktop installer (`okf-mcp.mcpb`).

[dash-wiki](https://github.com/DashAuction/dash-wiki) runs exactly this. The validator
lives here rather than in the bundle repositories because those are templates: template
clones fork and drift by design, and a checker baked into a template stays broken in
every clone already stamped from it.

## Development

```bash
npm test           # connector contract + git sync policy + manifest/registry tests
npm run typecheck
```

Every connector is tested against the same fixture bundle in `test/fixtures/`, so "all
connectors behave identically" is asserted rather than hoped.

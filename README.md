# okf-mcp

One MCP server that gives agents read access to any number of OKF bundles, wherever they
live. The server speaks MCP on one side and a small connector interface on the other; a
connector knows how to reach one kind of source — a git remote, a local directory — and
nothing about what the tools do with the content.

The full design rationale is in [docs/okf-mcp.md](docs/okf-mcp.md).

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
| `search_concepts(bundle, query)` | full-text search across a bundle's markdown |

When the registry holds exactly one bundle, the `bundle` parameter is optional and
defaults to it — so a dedicated single-corpus instance never repeats its own name. A
server fronting several bundles requires it, and the error names the candidates.

Each bundle's `AGENTS.md` is exposed as the MCP resource `okf://{bundle}/agents-guide`.

Read-only, deliberately: bundles are written by their own pipelines and corrected by
humans in git.

## Development

```bash
npm test           # connector contract + git sync policy + manifest/registry tests
npm run typecheck
```

Every connector is tested against the same fixture bundle in `test/fixtures/`, so "all
connectors behave identically" is asserted rather than hoped.

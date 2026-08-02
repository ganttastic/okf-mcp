# okf-mcp

One MCP server that gives agents read access to any number of OKF bundles, wherever they
live. The server speaks MCP on one side and a small connector interface on the other; a
connector knows how to reach one kind of source — a git remote, a local directory — and
nothing about what the tools do with the content.

The full design rationale is in [docs/okf-mcp.md](docs/okf-mcp.md).

## Setup

```bash
npm install
cp sources.example.json sources.json   # then edit; secrets stay in the environment
npm run build
```

Run over stdio (for an MCP client config):

```json
{
  "mcpServers": {
    "okf": {
      "command": "node",
      "args": ["/path/to/okf-mcp/dist/server.js"],
      "env": {
        "OKF_MCP_SOURCES": "/path/to/okf-mcp/sources.json",
        "OKF_GIT_TOKEN": "…"
      }
    }
  }
}
```

- `OKF_MCP_SOURCES` — path to the source registry (default: `./sources.json`)
- `OKF_MCP_CACHE_DIR` — where git clones live (default: `~/.cache/okf-mcp`)
- Registry `auth.env` names the environment variable holding a credential; config never
  holds one.

## Tools

| Tool | Purpose |
|---|---|
| `list_bundles()` | the source registry, with each bundle's last-sync time |
| `list_directories(bundle)` | category directories |
| `read_index(bundle, directory?)` | the designed discovery surface — prefer before search |
| `read_concept(bundle, path)` | one concept, verbatim bytes |
| `search_concepts(bundle, query)` | full-text search across a bundle's markdown |

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

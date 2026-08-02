# Contributing

The most useful contribution to okf-mcp is a new **connector** — the piece that knows
how to reach one kind of source (a git remote, a local directory, a Drive folder, an
object store) and nothing about what the tools do with the content. This guide is
mostly about adding one. For anything else: open an issue first, keep PRs small, and
make sure `npm test` and `npm run typecheck` are green.

## The connector contract

A connector implements [`OkfConnector`](src/connectors/types.ts). Three rules are
non-negotiable; each was learned the hard way by the ingestion pipeline this project
grew out of (see [docs/okf-mcp.md](docs/okf-mcp.md) §4):

1. **Reads are verbatim bytes.** No whitespace normalization, no line-ending
   translation, no trailing-newline adjustment. Consumers diff and edit against these
   reads. If your transport can mangle bytes (APIs that "helpfully" normalize), you
   must find the read path that doesn't.
2. **A failed fetch is not an empty bundle.** `resolveBundle` throws on failure — it
   never returns an empty handle. An agent once told "the bundle is empty" by a
   swallowed 403 duplicated concepts written minutes earlier.
3. **Staleness is a fact to report, never hide.** If your source mirrors a remote and
   a sync fails, serve the tree you have and set `stale` on the handle. A failed
   *initial* materialization is rule 2: throw.

Two design patterns to reuse:

- **Materialize, then delegate.** If your source can produce a working tree on disk,
  do the sync yourself and delegate every read to
  [`FilesystemConnector`](src/connectors/filesystem.ts) — that is the entire
  [git connector](src/connectors/git.ts): the filesystem connector plus a sync policy.
  You inherit verbatim reads, index synthesis, path-traversal protection, and search
  for free.
- **Credentials are named, never held.** `SourceConfig.auth.env` carries the *name* of
  an environment variable. Config files never contain a secret, and nothing writes
  one to disk (the git connector passes authenticated URLs per-invocation and keeps
  the clean URL in the remote).

`capabilities.search` and the optional `search`/`refresh` methods exist for sources
that genuinely cannot provide them — implement them when you can, and the server's
index-scan fallback covers `search` when you can't.

## Adding a connector, step by step

1. **Implement** `src/connectors/<kind>.ts`. Pick a short `kind` string; document
   what `location` means for it (the git connector uses `url#branch`, filesystem a
   path).
2. **Register** it in `main()` in [src/server.ts](src/server.ts) — one
   `connectors.set(...)` line.
3. **Add a lane to the contract suite.** [test/contract.test.ts](test/contract.test.ts)
   runs every connector against the same miniature bundle in `test/fixtures/`, so
   "all connectors behave identically" is asserted rather than hoped. Your lane
   provides a way to serve that fixture through your source kind (the git lane, for
   example, turns the fixture into a real repository in `beforeAll`). If your source
   can't be faked locally, say so in the PR — we'd rather discuss a recorded or
   emulated harness than skip the contract.
4. **Test your sync policy separately** if the source mirrors a remote — what happens
   on a failed refresh, a poisoned cache, a missing credential.
   [test/git-sync.test.ts](test/git-sync.test.ts) is the model, including the
   recovery rule: a mirror that needs merging has stopped being a mirror; recovery is
   delete and re-materialize.
5. **Document** the `sources.json` shape for your kind in the README's configuring
   section, and add an entry to `sources.example.json`.

Connectors the design doc already anticipates, if you want a starting point: a Google
Drive folder, S3/GCS buckets, and a pure-API GitHub connector for diskless
deployments (GraphQL `object { text oid }` reads preserve bytes; that pattern is
proven).

## What connectors must not do

The tool surface is read-only, deliberately: bundles are written by their own
pipelines and corrected by humans in git, and a write path through the MCP would
bypass both the attribution machinery and the authority ordering that makes human
corrections stick. Don't add one to your connector.

## Development

```bash
npm install
npm test            # contract + sync-policy + manifest/registry/validator suites
npm run typecheck
npx tsx src/server.ts --validate <bundle-dir>   # the CLI, straight from source
```

## License

Apache 2.0. Submitting a contribution means it's licensed under the same terms
(Apache 2.0 §5) — no CLA beyond that.

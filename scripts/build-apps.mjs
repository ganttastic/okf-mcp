// Bundle each MCP App into a single self-contained HTML file under dist/apps/.
// The app iframe runs under a deny-by-default CSP, so everything — JS and CSS —
// is inlined; there are no external fetches to allow.
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const APPS = ["bundles", "concept-status", "validation"];

// Shared card styling: the slate/amber language of the project icon, with a
// light-mode fallback via prefers-color-scheme.
const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 12px; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
       background: transparent; color: #e2e8f0; }
.card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px; margin-bottom: 10px; }
.card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.card-title { font-size: 16px; font-weight: 650; }
.card-sub { color: #94a3b8; font-size: 12px; margin-top: 2px; }
.card-desc { color: #cbd5e1; margin-top: 8px; }
.card-foot { color: #94a3b8; font-size: 12px; margin-top: 12px; }
.badges { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
.badge { border-radius: 999px; padding: 2px 10px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.badge-kind { background: #334155; color: #cbd5e1; }
.badge-version { background: #78350f; color: #fbbf24; }
.badge-warn { background: #7f1d1d; color: #fca5a5; }
.badge-tier-human-reviewed { background: #14532d; color: #86efac; }
.badge-tier-machine-confirmed { background: #1e3a5f; color: #93c5fd; }
.badge-tier-unverified { background: #334155; color: #94a3b8; }
.cat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; margin-top: 12px; }
.cat { background: #0f172a; border-radius: 8px; padding: 8px 10px; }
.cat-path { font-family: ui-monospace, monospace; font-size: 12px; color: #fbbf24; }
.cat-answers { color: #94a3b8; font-size: 12px; margin-top: 2px; font-style: italic; }
.rows { margin-top: 12px; display: grid; gap: 4px; }
.row { display: flex; gap: 10px; font-size: 13px; }
.row-label { color: #94a3b8; min-width: 84px; }
.row-value { color: #e2e8f0; font-family: ui-monospace, monospace; font-size: 12.5px; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.tag { background: #0f172a; color: #94a3b8; border-radius: 6px; padding: 2px 8px; font-size: 11px; }
.verdict { display: flex; align-items: center; gap: 14px; }
.verdict-mark { font-size: 26px; font-weight: 700; width: 44px; height: 44px; border-radius: 10px;
                display: flex; align-items: center; justify-content: center; }
.verdict-ok .verdict-mark { background: #14532d; color: #86efac; }
.verdict-bad .verdict-mark { background: #7f1d1d; color: #fca5a5; }
.issues { margin-top: 12px; display: grid; gap: 6px; }
.issue { display: grid; grid-template-columns: 64px auto; gap: 2px 10px; background: #0f172a; border-radius: 8px; padding: 8px 10px; font-size: 12.5px; }
.issue-sev { font-weight: 700; text-transform: uppercase; font-size: 10px; align-self: start; padding-top: 2px; }
.issue-error .issue-sev { color: #fca5a5; }
.issue-warning .issue-sev { color: #fbbf24; }
.issue-path { font-family: ui-monospace, monospace; color: #e2e8f0; }
.issue-msg { grid-column: 2; color: #94a3b8; }
.empty { color: #94a3b8; padding: 8px 2px; }
@media (prefers-color-scheme: light) {
  body { color: #0f172a; }
  .card { background: #f8fafc; border-color: #e2e8f0; }
  .card-desc { color: #334155; }
  .row-value { color: #0f172a; }
  .cat, .tag, .issue { background: #eef2f7; }
  .issue-path { color: #0f172a; }
  .badge-kind { background: #e2e8f0; color: #334155; }
  .badge-version { background: #fef3c7; color: #92400e; }
  .badge-warn { background: #fee2e2; color: #b91c1c; }
  .badge-tier-human-reviewed { background: #dcfce7; color: #166534; }
  .badge-tier-machine-confirmed { background: #dbeafe; color: #1e40af; }
  .badge-tier-unverified { background: #e2e8f0; color: #475569; }
  .verdict-ok .verdict-mark { background: #dcfce7; color: #166534; }
  .verdict-bad .verdict-mark { background: #fee2e2; color: #b91c1c; }
}
`;

mkdirSync(join(root, "dist", "apps"), { recursive: true });

for (const name of APPS) {
  const result = await build({
    entryPoints: [join(root, "src", "apps", `${name}.ts`)],
    bundle: true,
    format: "iife",
    minify: true,
    target: "es2022",
    write: false,
  });
  // A "</script" inside the bundled JS would terminate the inline tag early.
  const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>OKF ${name}</title>
<style>${CSS}</style>
</head>
<body>
<div id="root" class="empty">Loading…</div>
<script>${js}</script>
</body>
</html>
`;
  writeFileSync(join(root, "dist", "apps", `${name}.html`), html);
  console.log(`built dist/apps/${name}.html (${(html.length / 1024).toFixed(1)} KB)`);
}

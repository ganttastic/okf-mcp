#!/usr/bin/env node
// Bake deployment-specific defaults into a staged manifest.json so the
// installer's configuration form comes pre-filled:
//
//   inject-defaults.mjs <manifest> [--git <url>…] [--local <dir>…]
//                       [--name <id>] [--display-name <title>]
//
// --name matters when shipping several preconfigured installers: Claude
// Desktop identifies an extension by its name, so two installers with
// different defaults need different names to coexist.
import { readFileSync, writeFileSync } from "node:fs";

const [manifestPath, ...args] = process.argv.slice(2);
if (!manifestPath) {
  console.error(
    "usage: inject-defaults.mjs <manifest> [--git <url>…] [--local <dir>…] [--name <id>] [--display-name <title>]",
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const gitDefaults = [];
const localDefaults = [];
let sink;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--git") {
    sink = gitDefaults;
  } else if (arg === "--local") {
    sink = localDefaults;
  } else if (arg === "--name" || arg === "--display-name") {
    sink = undefined;
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    manifest[arg === "--name" ? "name" : "display_name"] = value;
  } else if (arg.startsWith("--")) {
    throw new Error(`Unknown option "${arg}"`);
  } else {
    if (!sink) throw new Error(`Unexpected argument "${arg}"`);
    sink.push(arg);
  }
}

if (gitDefaults.length) manifest.user_config.git_bundles.default = gitDefaults;
if (localDefaults.length) manifest.user_config.local_bundles.default = localDefaults;

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.error(
  `manifest "${manifest.name}": ` +
    `${gitDefaults.length} git default(s), ${localDefaults.length} local default(s)`,
);

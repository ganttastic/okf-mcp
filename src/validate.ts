import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { BundleHandle } from "./connectors/types.js";

/**
 * Producer-side conformance (OKF §11), which the lenient read path
 * deliberately never enforces: every non-reserved .md carries parseable
 * frontmatter with a non-empty type, and reserved files follow §8/§9 when
 * present. Errors are §11 violations; warnings are SHOULD-level slips in
 * the §5 families.
 */

export interface ValidationIssue {
  path: string;
  severity: "error" | "warning";
  message: string;
}

export interface ValidationReport {
  conformant: boolean; // true when there are no errors
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  checkedFiles: number;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const DATE_HEADING_RE = /^## (\d{4}-\d{2}-\d{2})$/;

export async function validateBundle(bundle: BundleHandle): Promise<ValidationReport> {
  const machinery = new Set(bundle.manifest.machinery ?? []);
  const issues: ValidationIssue[] = [];
  let checkedFiles = 0;

  const walk = async (relDir: string): Promise<void> => {
    const entries = await readdir(join(bundle.rootDir, relDir), { withFileTypes: true });
    for (const entry of entries) {
      const relPath = relDir ? join(relDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || machinery.has(relPath)) {
          continue;
        }
        await walk(relPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        checkedFiles++;
        const raw = await readFile(join(bundle.rootDir, relPath), "utf8");
        if (entry.name === "log.md") {
          checkLog(relPath, raw, issues);
        } else if (entry.name === "index.md") {
          checkIndex(relPath, raw, relPath === bundle.manifest.root, issues);
        } else {
          checkConcept(relPath, raw, issues);
        }
      }
    }
  };
  await walk("");

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return { conformant: errors.length === 0, errors, warnings, checkedFiles };
}

/** §8: index files carry no frontmatter, except the root MAY carry okf_version. */
function checkIndex(
  path: string,
  raw: string,
  isRoot: boolean,
  issues: ValidationIssue[],
): void {
  const frontmatter = parseBlock(path, raw, issues);
  if (frontmatter === undefined || frontmatter === null) return;
  const keys = Object.keys(frontmatter);
  const extras = isRoot ? keys.filter((k) => k !== "okf_version") : keys;
  if (extras.length > 0) {
    issues.push({
      path,
      severity: "error",
      message: isRoot
        ? `root index frontmatter may carry only okf_version (§8); found: ${extras.join(", ")}`
        : `index files carry no frontmatter (§8); found: ${extras.join(", ")}`,
    });
  }
}

/** §9: no frontmatter; ## headings are ISO dates, newest first. */
function checkLog(path: string, raw: string, issues: ValidationIssue[]): void {
  if (FRONTMATTER_RE.test(raw)) {
    issues.push({ path, severity: "error", message: "log files carry no frontmatter (§9)" });
  }
  const dates: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("## ")) continue;
    const match = DATE_HEADING_RE.exec(line);
    if (!match) {
      issues.push({
        path,
        severity: "error",
        message: `log entry headings are ISO dates, "## YYYY-MM-DD" (§9); found: "${line}"`,
      });
    } else {
      dates.push(match[1]);
    }
  }
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] > dates[i - 1]) {
      issues.push({
        path,
        severity: "warning",
        message: `log entries should run newest first (§9); ${dates[i]} follows ${dates[i - 1]}`,
      });
      break;
    }
  }
}

/** §11: parseable frontmatter with a non-empty type; §5 families well-formed. */
function checkConcept(path: string, raw: string, issues: ValidationIssue[]): void {
  if (!FRONTMATTER_RE.test(raw)) {
    issues.push({ path, severity: "error", message: "concept has no frontmatter (§11)" });
    return;
  }
  const frontmatter = parseBlock(path, raw, issues);
  if (frontmatter === undefined) return; // parse error already recorded
  if (frontmatter === null || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    issues.push({ path, severity: "error", message: "frontmatter is not a mapping (§4)" });
    return;
  }
  const fm = frontmatter as Record<string, unknown>;

  if (typeof fm["type"] !== "string" || fm["type"].trim() === "") {
    issues.push({ path, severity: "error", message: 'frontmatter has no non-empty "type" (§11)' });
  }

  if (fm["sources"] !== undefined) {
    if (!Array.isArray(fm["sources"])) {
      issues.push({ path, severity: "warning", message: "sources should be a list (§5.1)" });
    } else {
      fm["sources"].forEach((entry, i) => {
        if (entry === null || typeof entry !== "object" || typeof (entry as Record<string, unknown>)["resource"] !== "string") {
          issues.push({
            path,
            severity: "warning",
            message: `sources[${i}] has no "resource" — required per entry (§5.1)`,
          });
        }
      });
    }
  }

  const generated = fm["generated"];
  if (generated !== undefined) {
    if (generated === null || typeof generated !== "object" || typeof (generated as Record<string, unknown>)["by"] !== "string") {
      issues.push({ path, severity: "warning", message: 'generated needs "by" (§5.2)' });
    }
  }

  const verified = fm["verified"];
  if (verified !== undefined) {
    const entries = Array.isArray(verified) ? verified : [verified];
    entries.forEach((entry, i) => {
      if (entry === null || typeof entry !== "object" || typeof (entry as Record<string, unknown>)["by"] !== "string") {
        issues.push({ path, severity: "warning", message: `verified[${i}] needs "by" (§5.2)` });
      }
    });
  }

  const status = fm["status"];
  if (status !== undefined && !["draft", "stable", "deprecated"].includes(String(status))) {
    issues.push({
      path,
      severity: "warning",
      message: `status is "${String(status)}"; §5.4 defines draft | stable | deprecated`,
    });
  }

  const staleAfter = fm["stale_after"];
  if (staleAfter !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(staleAfter))) {
    issues.push({
      path,
      severity: "warning",
      message: `stale_after should be YYYY-MM-DD (§5.5); found "${String(staleAfter)}"`,
    });
  }
}

/** Returns the parsed mapping, null when there is no block, undefined on a parse error. */
function parseBlock(
  path: string,
  raw: string,
  issues: ValidationIssue[],
): unknown | null | undefined {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return null;
  try {
    return parseYaml(match[1]) ?? {};
  } catch (err) {
    issues.push({
      path,
      severity: "error",
      message: `frontmatter is not parseable YAML (§11): ${(err as Error).message.split("\n")[0]}`,
    });
    return undefined;
  }
}

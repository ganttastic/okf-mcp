import { parse as parseYaml } from "yaml";

export interface ParsedDoc {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Split a document into YAML frontmatter and body. The input is never
 * modified — callers keep the raw string; this only derives views of it.
 */
export function parseFrontmatter(raw: string): ParsedDoc {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw };
  const parsed = parseYaml(match[1]);
  const frontmatter =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { frontmatter, body: raw.slice(match[0].length) };
}

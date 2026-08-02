import { readFile } from "node:fs/promises";
import type { SourceConfig } from "./connectors/types.js";

/**
 * sources.json — checked in; secrets stay in the environment (§6).
 * Config names the environment variable that holds a credential; it never
 * holds one.
 */
export async function loadRegistry(path: string): Promise<Map<string, SourceConfig>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`Cannot read source registry at ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Source registry ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Source registry ${path} must be an object of name → source`);
  }

  const registry = new Map<string, SourceConfig>();
  for (const [name, value] of Object.entries(parsed)) {
    registry.set(name, validateSource(name, value, path));
  }
  if (registry.size === 0) {
    throw new Error(`Source registry ${path} defines no sources`);
  }
  return registry;
}

function validateSource(name: string, value: unknown, path: string): SourceConfig {
  const where = `source "${name}" in ${path}`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  const source = value as Record<string, unknown>;
  if (typeof source["kind"] !== "string") {
    throw new Error(`${where} is missing "kind"`);
  }
  if (typeof source["location"] !== "string") {
    throw new Error(`${where} is missing "location"`);
  }
  const auth = source["auth"];
  if (auth !== undefined) {
    if (
      auth === null ||
      typeof auth !== "object" ||
      typeof (auth as Record<string, unknown>)["env"] !== "string"
    ) {
      throw new Error(`${where}: "auth" must be { "env": "VAR_NAME" } — never a credential`);
    }
  }
  const staleness = source["maxStalenessMinutes"];
  if (staleness !== undefined && (typeof staleness !== "number" || staleness < 0)) {
    throw new Error(`${where}: "maxStalenessMinutes" must be a non-negative number`);
  }
  return source as unknown as SourceConfig;
}

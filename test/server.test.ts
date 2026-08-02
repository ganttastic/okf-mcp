import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { FilesystemConnector } from "../src/connectors/filesystem.js";
import type { OkfConnector, SourceConfig } from "../src/connectors/types.js";
import { createServer } from "../src/server.js";

const WITH_MANIFEST = fileURLToPath(new URL("./fixtures/with-manifest", import.meta.url));
const NO_MANIFEST = fileURLToPath(new URL("./fixtures/no-manifest", import.meta.url));

async function connect(registry: Map<string, SourceConfig>): Promise<Client> {
  const connectors = new Map<string, OkfConnector>();
  const filesystem = new FilesystemConnector();
  connectors.set(filesystem.kind, filesystem);
  const server = createServer({ registry, connectors, handles: new Map() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function resultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text: string }[])[0].text;
}

describe("bundle parameter defaulting", () => {
  describe("single-bundle server", () => {
    let client: Client;

    beforeAll(async () => {
      client = await connect(
        new Map([["only", { kind: "filesystem", location: WITH_MANIFEST }]]),
      );
    });

    it("defaults bundle when omitted", async () => {
      const result = await client.callTool({ name: "read_index", arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(resultText(result)).toContain("# Test Bundle");
    });

    it("defaults for every bundle-taking tool", async () => {
      const dirs = await client.callTool({ name: "list_directories", arguments: {} });
      expect(JSON.parse(resultText(dirs))).toEqual(["business", "operations"]);

      const concept = await client.callTool({
        name: "read_concept",
        arguments: { path: "business/buyers-premium.md" },
      });
      expect(resultText(concept)).toContain("hammer price");

      const hits = await client.callTool({
        name: "search_concepts",
        arguments: { query: "hammer price" },
      });
      expect(JSON.parse(resultText(hits)).length).toBeGreaterThan(0);
    });

    it("still accepts the explicit name", async () => {
      const result = await client.callTool({
        name: "read_index",
        arguments: { bundle: "only", directory: "business" },
      });
      expect(resultText(result)).toContain("# Business");
    });
  });

  describe("multi-bundle server", () => {
    let client: Client;

    beforeAll(async () => {
      client = await connect(
        new Map([
          ["first", { kind: "filesystem", location: WITH_MANIFEST }],
          ["second", { kind: "filesystem", location: NO_MANIFEST }],
        ]),
      );
    });

    it("requires bundle, and the error names the candidates", async () => {
      const result = await client.callTool({ name: "read_index", arguments: {} });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('"bundle" is required');
      expect(resultText(result)).toContain("first, second");
    });

    it("routes by explicit bundle name", async () => {
      const result = await client.callTool({
        name: "read_index",
        arguments: { bundle: "second" },
      });
      expect(resultText(result)).toContain("# Legacy Bundle");
    });

    it("rejects unknown bundle names", async () => {
      const result = await client.callTool({
        name: "read_index",
        arguments: { bundle: "third" },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('Unknown bundle "third"');
    });
  });
});

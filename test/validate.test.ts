import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FilesystemConnector } from "../src/connectors/filesystem.js";
import { validateBundle } from "../src/validate.js";

const WITH_MANIFEST = fileURLToPath(new URL("./fixtures/with-manifest", import.meta.url));
const NO_MANIFEST = fileURLToPath(new URL("./fixtures/no-manifest", import.meta.url));

const connector = new FilesystemConnector();

async function validateAt(location: string) {
  const bundle = await connector.resolveBundle("v", { kind: "filesystem", location });
  return validateBundle(bundle);
}

describe("bundle validation (§11)", () => {
  it("passes the conformant fixture, skipping machinery", async () => {
    const report = await validateAt(WITH_MANIFEST);
    expect(report.errors).toEqual([]);
    expect(report.conformant).toBe(true);
    // docs/ is machinery and its frontmatter-less index must not be checked
    expect(report.checkedFiles).toBe(6);
  });

  it("flags the legacy fixture's frontmatter-less concept", async () => {
    const report = await validateAt(NO_MANIFEST);
    expect(report.conformant).toBe(false);
    expect(report.errors).toEqual([
      expect.objectContaining({
        path: join("alpha", "thing.md"),
        message: expect.stringContaining("no frontmatter"),
      }),
    ]);
  });

  describe("violations", () => {
    let dir: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "okf-mcp-validate-"));
      await writeFile(join(dir, "index.md"), "---\nokf_version: \"0.2\"\ntitle: Sneaky\n---\n\n# Root\n");
      await writeFile(join(dir, "log.md"), "---\ntype: Reference\n---\n\n# Log\n\n## 2026-07-26T15:31:20Z — thing (create)\n\n## 2026-01-01\n\n* a\n\n## 2026-02-01\n\n* b\n");
      await mkdir(join(dir, "cat"));
      await writeFile(join(dir, "cat", "index.md"), "---\ntype: Reference\n---\n\n# Cat\n");
      await writeFile(join(dir, "cat", "no-type.md"), "---\ntitle: X\n---\n\nBody.\n");
      await writeFile(join(dir, "cat", "bad-yaml.md"), "---\ntype: [unclosed\n---\n\nBody.\n");
      await writeFile(
        join(dir, "cat", "sloppy-families.md"),
        "---\ntype: Concept\nstatus: retired\nstale_after: soon\nsources:\n  - title: no resource here\ngenerated:\n  at: 2026-01-01T00:00:00Z\nverified:\n  - at: 2026-01-01T00:00:00Z\n---\n\nBody.\n",
      );
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("reports every §8/§9/§11 error and §5 warning", async () => {
      const report = await validateAt(dir);
      const messages = (issues: typeof report.errors) => issues.map((i) => `${i.path}: ${i.message}`);

      expect(report.conformant).toBe(false);
      expect(messages(report.errors)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("root index frontmatter may carry only okf_version"),
          expect.stringContaining("log files carry no frontmatter"),
          expect.stringContaining('ISO dates, "## YYYY-MM-DD"'),
          expect.stringContaining("index files carry no frontmatter"),
          expect.stringContaining('no non-empty "type"'),
          expect.stringContaining("not parseable YAML"),
        ]),
      );
      expect(messages(report.warnings)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("newest first"),
          expect.stringContaining('sources[0] has no "resource"'),
          expect.stringContaining('generated needs "by"'),
          expect.stringContaining('verified[0] needs "by"'),
          expect.stringContaining('status is "retired"'),
          expect.stringContaining("stale_after should be YYYY-MM-DD"),
        ]),
      );
    });
  });
});

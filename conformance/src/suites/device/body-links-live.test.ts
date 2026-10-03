import { afterAll, beforeAll, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliFolder } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import {
  cleanup,
  createTestContext,
  trackFolder,
  trackItem,
} from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "body-links",
  ));
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
});
function value<T>(result: Outcome<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.refusal.raw);
  return result.value;
}

it("resolves body links through real server lookup and keeps their removal after pull", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marfa-body-links-"));
  const folder = new CliFolder(dir, {
    binary: requireBinary(),
    url: apiUrl,
    key: apiKey,
    registry: join(dir, "registry.json"),
  });
  try {
    const remoteTitle = `Remote ${ctx.runId}`;
    const remote = await client.createItem({
      type: "core.bookmark",
      properties: { title: remoteTitle, url: "https://example.com/body-links" },
    });
    expect(remote.ok, JSON.stringify(remote.error)).toBe(true);
    trackItem(ctx, remote.data.item.id);
    const settings = await client.createFolder({
      title: `Body links ${ctx.runId}`,
      search: { types: ["core.note"], filter: `source eq "${ctx.source}"` },
    });
    expect(settings.ok, JSON.stringify(settings.error)).toBe(true);
    trackFolder(ctx, settings.data.item.id);
    value(await folder.add(settings.data.item.id));
    value(await folder.hydrate());
    mkdirSync(join(dir, "projects"));
    writeFileSync(
      join(dir, "projects", "Target.md"),
      `---\ntitle: Different ${ctx.runId}\n---\ntarget\n`,
    );
    const sourcePath = join(dir, "Source.md");
    const body = `[[Target#Heading|shown]] [[${remoteTitle}#Heading]] [[#local]]\n\`[[Nowhere]]\` <!-- [[Nowhere]] -->\n`;
    writeFileSync(sourcePath, `---\ntitle: Source ${ctx.runId}\n---\n${body}`);
    const pushed = value(await folder.push());
    expect(pushed.scan.flagged).toEqual([]);
    const listed = await client.listItems({
      type: "core.note",
      filter: `source eq "${ctx.source}"`,
      limit: 100,
    });
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    for (const row of listed.data.data) trackItem(ctx, row.id);
    const source = listed.data.data.find(
      (row) => row.properties.title === `Source ${ctx.runId}`,
    )!;
    const target = listed.data.data.find(
      (row) => row.properties.title === `Different ${ctx.runId}`,
    )!;
    expect(source).toBeDefined();
    expect(target).toBeDefined();
    const targets = async () => {
      const result = await client.listItemEdges(source.id, {
        edge_type: "references",
      });
      expect(result.ok, JSON.stringify(result.error)).toBe(true);
      return result.data.data.map((edge) => edge.target_id).sort();
    };
    expect(await targets()).toEqual([target.id, remote.data.item.id].sort());
    value(await folder.pull());
    let text = readFileSync(sourcePath, "utf8");
    expect(text).toContain(body);
    expect(text).not.toContain("references:");
    writeFileSync(
      sourcePath,
      text.replace(body, `[[Target#Heading]] [[Missing ${ctx.runId}]]\n`),
    );
    const unresolved = value(await folder.push());
    expect(
      unresolved.scan.flagged.find((row) => row.path === "Source.md")?.reason,
    ).toContain("matches no item");
    expect(await targets()).toEqual([target.id, remote.data.item.id].sort());
    text = readFileSync(sourcePath, "utf8");
    writeFileSync(sourcePath, text.replace(` [[Missing ${ctx.runId}]]`, ""));
    value(await folder.push());
    expect(await targets()).toEqual([target.id]);
    text = readFileSync(sourcePath, "utf8");
    writeFileSync(sourcePath, text.replace("[[Target#Heading]]", "removed"));
    value(await folder.push());
    expect(await targets()).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

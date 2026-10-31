import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  getOwnerClient,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import {
  listTarGzEntries,
  readTarGzEntry,
  tarGz,
} from "../../utils/archive.js";
import {
  approvedAppToken,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
} from "../../utils/fresh-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { TEST_OWNER } from "../../utils/target.js";

/**
 * A source's name and mark (`keys-and-oauth/source-*`), and the counts of
 * items by source (`search-and-filters/stats-group`). Every source here is
 * built from this file's own, and `afterAll` clears every name it set.
 */

interface Source {
  source: string;
  name: string;
  name_from: string;
  mark?: string;
}

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let owner: MarfaClient;
const named = new Set<string>();

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "source-names",
  ));
  owner = getOwnerClient();
});

afterAll(async () => {
  for (const source of named) {
    await owner.rawRequest(sourcePath(source), {
      method: "PATCH",
      body: { name: null, mark: null },
    });
  }
  await cleanup(ctx);
});

function sourcePath(source: string): string {
  return `/source?source=${encodeURIComponent(source)}`;
}

function readSource(as: MarfaClient, source: string) {
  return as.rawRequest<Source>(sourcePath(source));
}

function nameSource(
  as: MarfaClient,
  source: string,
  body: { name?: string | null; mark?: string | null },
) {
  named.add(source);
  return as.rawRequest<Source>(sourcePath(source), { method: "PATCH", body });
}

async function listSources(as: MarfaClient): Promise<Source[]> {
  const listed = await as.rawRequest<{ data: Source[] }>("/sources");
  expect(listed.status, JSON.stringify(listed.error)).toBe(200);
  return listed.data.data;
}

/** A key the owner mints under a source built from this file's own. */
async function mintKey(
  suffix: string,
  extra: Record<string, unknown> = {},
): Promise<{ client: MarfaClient; id: string; source: string }> {
  const source = `${ctx.source}-${suffix}`;
  const minted = await owner.createKey({
    label: `Label ${suffix}`,
    source,
    type_permissions: { "core.note": "write" },
    ...extra,
  } as Parameters<MarfaClient["createKey"]>[0]);
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  trackKey(ctx, minted.data.id);
  return {
    client: new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key }),
    id: minted.data.id,
    source,
  };
}

async function writeNote(as: MarfaClient, source: string, tags: string[] = []) {
  const made = await as.createItem({ ...createNote({ source }), tags });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackItem(ctx, made.data.item.id);
}

describe("GET /items/stats?by=source", () => {
  it("counts items by source under a listing's filters", async () => {
    const tag = `by-source-${ctx.runId}`;
    const other = await mintKey("stats-other");
    await writeNote(client, ctx.source, [tag]);
    await writeNote(client, ctx.source, [tag]);
    await writeNote(client, ctx.source);
    await writeNote(other.client, other.source, [tag]);

    const counted = await client.rawRequest<Record<string, number>>(
      `/items/stats?by=source&tags=${encodeURIComponent(tag)}`,
    );
    expect(counted.status, JSON.stringify(counted.error)).toBe(200);
    await expectMatchesSchema("GET", "/items/stats", 200, counted.data);
    // The untagged note is left out, so the tag filter holds.
    expect(counted.data).toEqual({ [ctx.source]: 2, [other.source]: 1 });

    const narrowed = await client.rawRequest<Record<string, number>>(
      `/items/stats?by=source&tags=${encodeURIComponent(tag)}&source=${encodeURIComponent(other.source)}`,
    );
    expect(narrowed.data).toEqual({ [other.source]: 1 });
  });
});

describe("a source's name", () => {
  it("is the name set on it, then its key's label, then its code", async () => {
    const key = await mintKey("named");
    const labelled = await readSource(key.client, key.source);
    expect(labelled.status, JSON.stringify(labelled.error)).toBe(200);
    await expectMatchesSchema("GET", "/source", 200, labelled.data);
    expect(labelled.data).toEqual({
      source: key.source,
      name: "Label named",
      name_from: "key",
    });

    const set = await nameSource(owner, key.source, { name: "Set name" });
    expect(set.status, JSON.stringify(set.error)).toBe(200);
    await expectMatchesSchema("PATCH", "/source", 200, set.data);
    expect(set.data).toEqual({
      source: key.source,
      name: "Set name",
      name_from: "set",
    });

    const bare = `${ctx.source}-bare`;
    const code = await readSource(owner, bare);
    expect(code.data).toEqual({ source: bare, name: bare, name_from: "code" });

    const listed = await key.client.rawRequest<{ data: Source[] }>("/sources");
    await expectMatchesSchema("GET", "/sources", 200, listed.data);
    expect(listed.data.data).toContainEqual(set.data);
  });

  it("takes no key's label for a claimed source", async () => {
    const claimed = `${ctx.source}-claimed`;
    // The witness: the same key's own source takes its label.
    const key = await mintKey("claimer", { sources: [claimed] });
    expect((await readSource(key.client, key.source)).data.name_from).toBe(
      "key",
    );
    const seen = await readSource(key.client, claimed);
    expect(seen.status, JSON.stringify(seen.error)).toBe(200);
    expect(seen.data).toEqual({
      source: claimed,
      name: claimed,
      name_from: "code",
    });
  });

  it("keeps a set name when its source passes to a new key, and drops the revoked key's label", async () => {
    const first = await mintKey("passing");
    const kept = await mintKey("passing-kept");
    expect(
      (await nameSource(owner, kept.source, { name: "Kept name" })).status,
    ).toBe(200);
    expect((await readSource(owner, first.source)).data.name).toBe(
      "Label passing",
    );
    for (const key of [first, kept]) {
      expect((await owner.revokeKey(key.id)).status).toBe(200);
    }
    expect((await readSource(owner, first.source)).data).toMatchObject({
      name: first.source,
      name_from: "code",
    });

    for (const source of [first.source, kept.source]) {
      const minted = await owner.createKey({
        label: "New label",
        source,
        type_permissions: { "core.note": "read" },
      });
      expect(minted.status, JSON.stringify(minted.error)).toBe(201);
      trackKey(ctx, minted.data.id);
    }
    expect((await readSource(owner, first.source)).data).toMatchObject({
      name: "New label",
      name_from: "key",
    });
    expect((await readSource(owner, kept.source)).data).toMatchObject({
      name: "Kept name",
      name_from: "set",
    });
  });

  it(
    "is an app's sign-in name for the source the app writes under",
    async () => {
      // A source an app writes under is made by a sign-in, which needs an
      // owner and an approval: the story needs a server of its own.
      const server = await bootFreshServer("source-names-app");
      try {
        const app = new MarfaClient({
          baseUrl: server.apiUrl,
          apiKey: await approvedAppToken(server),
        });
        const own = (await listSources(app)).filter((s) =>
          s.source.startsWith("oauth:"),
        );
        expect(own).toHaveLength(1);
        expect(own[0]?.name_from).toBe("app");
        expect(own[0]?.name).not.toBe(own[0]?.source);
        const ownerClient = new MarfaClient({
          baseUrl: server.apiUrl,
          ownerCookie: server.ownerCookie,
          ownerCredentials: TEST_OWNER,
        });
        expect(
          (await readSource(ownerClient, own[0]?.source ?? "")).data,
        ).toEqual(own[0]);
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("setting a source's name and mark", () => {
  it("lets a key set its own source and one it claims, and refuses another without keys.manage", async () => {
    const claimed = `${ctx.source}-set-claimed`;
    const other = `${ctx.source}-set-other`;
    const key = await mintKey("setter", { sources: [claimed] });

    const own = await nameSource(key.client, key.source, {
      name: "Own name",
      mark: "simple-icons:github",
    });
    expect(own.status, JSON.stringify(own.error)).toBe(200);
    expect(own.data).toEqual({
      source: key.source,
      name: "Own name",
      name_from: "set",
      mark: "simple-icons:github",
    });
    const claim = await nameSource(key.client, claimed, { mark: "lucide:box" });
    expect(claim.status, JSON.stringify(claim.error)).toBe(200);
    expect(claim.data.mark).toBe("lucide:box");

    const refused = await nameSource(key.client, other, { name: "Nope" });
    expect(refused.status).toBe(403);
    await expectMatchesSchema("PATCH", "/source", 403, refused.error);
    expect(refused.error?.error.code).toBe("forbidden");
    expect(refused.error?.error.details?.required_scope).toBe("keys.manage");
    expect((await readSource(owner, other)).data.name_from).toBe("code");

    const manager = await mintKey("manager", { permissions: ["keys.manage"] });
    const allowed = await nameSource(manager.client, other, { name: "Named" });
    expect(allowed.status, JSON.stringify(allowed.error)).toBe(200);
    expect(allowed.data.name).toBe("Named");
  });

  it("refuses a mark outside the pinned icon sets with invalid_schema, and sets nothing", async () => {
    const key = await mintKey("bad-mark");
    for (const mark of ["lucide:not-an-icon", "star", "nosuchset:github"]) {
      const refused = await nameSource(key.client, key.source, { mark });
      expect(refused.status, mark).toBe(400);
      await expectMatchesSchema("PATCH", "/source", 400, refused.error);
      expect(refused.error?.error.code).toBe("invalid_schema");
    }
    expect(
      (await readSource(key.client, key.source)).data.mark,
    ).toBeUndefined();
  });

  it("keeps a field left out, and clears one sent as null", async () => {
    const key = await mintKey("clearing");
    await nameSource(key.client, key.source, {
      name: "Both",
      mark: "lucide:box",
    });
    const markGone = await nameSource(key.client, key.source, { mark: null });
    expect(markGone.data).toEqual({
      source: key.source,
      name: "Both",
      name_from: "set",
    });
    const nameGone = await nameSource(key.client, key.source, { name: null });
    expect(nameGone.data).toEqual({
      source: key.source,
      name: "Label clearing",
      name_from: "key",
    });
  });
});

describe("a source's code", () => {
  it("travels in the query, so a code a path would rewrite reaches its source", async () => {
    for (const source of [`${ctx.source}/..`, `${ctx.source}/a b?c#d`]) {
      const set = await nameSource(owner, source, { name: "Odd code" });
      expect(set.status, JSON.stringify(set.error)).toBe(200);
      expect(set.data.source).toBe(source);
      expect((await readSource(owner, source)).data).toMatchObject({
        source,
        name: "Odd code",
      });
    }
  });

  it("records a change to a source's name in the audit log", async () => {
    const source = `${ctx.source}-audited`;
    expect((await nameSource(owner, source, { name: "Audited" })).status).toBe(
      200,
    );
    const rows = await client.listAudit({
      resource_type: "source",
      resource_id: source,
    });
    expect(rows.ok, JSON.stringify(rows.error)).toBe(true);
    expect(rows.data.data.map((row) => row.action)).toContain("source.update");
  });
});

describe("reading a source", () => {
  it("answers source_not_found for a source the credential cannot see, and leaves it out of the list", async () => {
    const writer = await mintKey("hidden");
    await writeNote(writer.client, writer.source);
    await nameSource(owner, writer.source, { name: "Hidden name" });

    const blind = await mintKey("blind", {
      type_permissions: { "core.task": "read" },
    });
    const refused = await readSource(blind.client, writer.source);
    expect(refused.status).toBe(404);
    await expectMatchesSchema("GET", "/source", 404, refused.error);
    expect(refused.error?.error.code).toBe("source_not_found");
    expect((await listSources(blind.client)).map((s) => s.source)).toEqual([
      blind.source,
    ]);

    // The witness: a key that reads notes sees the note's source.
    const reader = await mintKey("reader", {
      type_permissions: { "core.note": "read" },
    });
    expect((await readSource(reader.client, writer.source)).data.name).toBe(
      "Hidden name",
    );
    expect((await listSources(reader.client)).map((s) => s.source)).toContain(
      writer.source,
    );
  });
});

describe("source names in an archive", () => {
  it("carries a named source in an archive and adds it back where the instance names none, replacing none", async () => {
    await writeNote(client, ctx.source);
    expect(
      (
        await nameSource(owner, ctx.source, {
          name: "Archived name",
          mark: "lucide:box",
        })
      ).status,
    ).toBe(200);
    const archive = await client.exportArchive({ source: ctx.source });
    expect(archive.status).toBe(200);
    const lines = (readTarGzEntry(archive.data, "types.ndjson") ?? "")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const carried = lines.filter((line) => "source" in line);
    expect(carried.map((line) => line.source)).toEqual([
      { source: ctx.source, name: "Archived name", mark: "lucide:box" },
    ]);
    const manifest = JSON.parse(
      readTarGzEntry(archive.data, "manifest.json") ?? "{}",
    ) as { source_count: number };
    expect(manifest.source_count).toBe(1);

    // A name set since the export stays.
    await nameSource(owner, ctx.source, { name: "Newer name", mark: null });
    const kept = await owner.restoreArchive(archive.data);
    expect(kept.ok, JSON.stringify(kept.error)).toBe(true);
    expect(kept.data.sources_skipped_reasons.already_set).toBe(1);
    expect((await readSource(owner, ctx.source)).data).toMatchObject({
      name: "Newer name",
    });

    // With none set, the archive's is added.
    await nameSource(owner, ctx.source, { name: null });
    const added = await owner.restoreArchive(archive.data);
    expect(added.ok, JSON.stringify(added.error)).toBe(true);
    expect(added.data.sources_added).toBe(1);
    expect((await readSource(owner, ctx.source)).data).toMatchObject({
      name: "Archived name",
      mark: "lucide:box",
    });
  });

  it("skips and counts a mark outside the pinned sets, and refuses a damaged source line, writing nothing", async () => {
    await writeNote(client, ctx.source);
    const archive = await client.exportArchive({ source: ctx.source });
    expect(archive.status).toBe(200);
    const target = `${ctx.source}-restored`;
    named.add(target);
    const withLine = (line: unknown) =>
      tarGz(
        listTarGzEntries(archive.data).map((entry) => ({
          name: entry.name,
          body:
            entry.name === "types.ndjson"
              ? entry.body.toString("utf8") +
                `${JSON.stringify({ source: line })}\n`
              : entry.body,
        })),
      );

    const skipped = await owner.restoreArchive(
      withLine({ source: target, name: "Odd", mark: "lucide:not-an-icon" }),
    );
    expect(skipped.ok, JSON.stringify(skipped.error)).toBe(true);
    expect(skipped.data.sources_skipped_reasons.unknown_mark).toBe(1);
    expect((await readSource(owner, target)).data.name_from).toBe("code");

    for (const line of [
      { name: "No code" },
      { source: target },
      { source: target, mark: 7 },
      "not an object",
    ]) {
      const refused = await owner.restoreArchive(withLine(line));
      expect(refused.status, JSON.stringify(line)).toBe(400);
      expect(refused.error?.error.code).toBe("invalid_schema");
    }
    expect((await readSource(owner, target)).data.name_from).toBe("code");

    // An app's source is restored under the code a restore gives an app's
    // rows, which no app holds.
    const app = `oauth:${ctx.runId}:owner`;
    const restoredApp = `restored:${app}`;
    named.add(restoredApp);
    const mapped = await owner.restoreArchive(
      withLine({ source: app, name: "An app" }),
    );
    expect(mapped.ok, JSON.stringify(mapped.error)).toBe(true);
    expect((await readSource(owner, restoredApp)).data).toMatchObject({
      name: "An app",
      name_from: "set",
    });
    expect((await readSource(owner, app)).data.name_from).not.toBe("set");

    // The witness: the same line with a pinned mark is restored.
    const restored = await owner.restoreArchive(
      withLine({ source: target, name: "Odd", mark: "simple-icons:github" }),
    );
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    expect((await readSource(owner, target)).data).toMatchObject({
      name: "Odd",
      mark: "simple-icons:github",
    });
  });
});

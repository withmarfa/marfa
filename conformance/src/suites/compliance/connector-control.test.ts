import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import { archiveLines } from "../../utils/archive.js";
import {
  type ConnectorPlugin,
  connectorBundle,
  connectorKey,
  fresh,
  installed,
  local,
  mint,
  paths,
} from "../../utils/connector-plugin.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

/**
 * Pausing a plugin's connector, asking it to run now, and the mapping
 * previews it renders (`plugins/control-*`, `plugins/pause*`,
 * `plugins/run-*`, `plugins/preview-*`,
 * `archive/connector-control-not-carried`). Each server is the fixture's own,
 * since a plugin is the instance's, one test moves the clock and an export
 * and a restore are the whole instance's.
 */
let server: FreshServer;
let destination: FreshServer;
let owner: MarfaClient;
let stranger: MarfaClient;

const TEN_MINUTES_MS = 10 * 60 * 1000;

beforeAll(async () => {
  [server, destination] = await Promise.all([
    bootFreshServer("connector-control"),
    bootFreshServer("connector-control-destination"),
  ]);
  owner = (
    await mint(
      server,
      "control-owner",
      ["schema.write", "connectors.manage", "backups.manage", "audit.read"],
      { "*": "write" },
    )
  ).client;
  stranger = (
    await mint(server, "control-stranger", ["schema.write"], { "*": "write" })
  ).client;
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all([server?.stop(), destination?.stop()]);
}, FRESH_SERVER_TIMEOUT_MS);

async function control(name: string, by: MarfaClient = owner) {
  const read = await by.getConnectorControl(name);
  expect(read.status, JSON.stringify(read.error)).toBe(200);
  return read.data;
}

async function acted(name: string, act: "pause" | "resume" | "run") {
  const answer = await owner.controlConnector(name, act);
  expect(answer.status, JSON.stringify(answer.error)).toBe(200);
  await expectMatchesSchema(
    "POST",
    `/plugins/{name}/connector/${act}`,
    200,
    answer.data,
  );
  return answer.data;
}

/** The connector's entry in its host's own listing. */
async function hosted(host: MarfaClient, name: string) {
  const self = await host.connectorHostSelf();
  expect(self.status, JSON.stringify(self.error)).toBe(200);
  const entry = (self.data.connectors as Record<string, unknown>[]).find(
    (connector) => connector.plugin === name,
  );
  expect(entry).toBeDefined();
  return entry as Record<string, unknown>;
}

/** An item of the plugin's issue kind, written by its connector key. */
async function issue(own: MarfaClient, plugin: ConnectorPlugin) {
  const made = await own.createItem({
    type: plugin.issue,
    properties: { title: `issue ${fresh()}` },
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return made.data.item;
}

async function previewed(name: string, body: Record<string, unknown>) {
  const made = await owner.requestMappingPreview(name, body);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return made.data;
}

function refusedForScope(answer: { status: number; error?: any }) {
  expect(answer.status).toBe(403);
  expect(answer.error?.error.code).toBe("forbidden");
  expect(answer.error?.error.details?.required_scope).toBe("connectors.manage");
}

describe("pausing and running a connector", () => {
  it("stores a pause, a resume and a run request, answering each on the connector's door and to its host", async () => {
    const plugin = await installed(owner);
    const { client: own, host } = await connectorKey(server, plugin);
    const hostId = (await host.connectorHostSelf()).data.id as string;

    const first = await owner.getConnectorControl(plugin.name);
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    await expectMatchesSchema(
      "GET",
      "/plugins/{name}/connector",
      200,
      first.data,
    );
    expect(first.data).toEqual({
      plugin: plugin.name,
      source: plugin.source,
      host: hostId,
      registration: null,
      paused: false,
      run_requested_at: null,
      mapping_version: 0,
      rewrites: 0,
      previews: 0,
    });
    expect(await hosted(host, plugin.name)).toMatchObject({
      paused: false,
      run_requested_at: null,
    });

    const registered = await own.registerConnector({ name: "Tracker" });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const asConnector = await control(plugin.name, own);
    expect(asConnector.registration).toBe(registered.data.id);
    expect(await control(plugin.name)).toEqual(asConnector);

    const asked = await acted(plugin.name, "run");
    expect(asked.paused).toBe(false);
    expect(typeof asked.run_requested_at).toBe("string");
    expect(await control(plugin.name, own)).toEqual(asked);
    expect(await hosted(host, plugin.name)).toMatchObject({
      paused: false,
      run_requested_at: asked.run_requested_at,
    });

    const paused = await acted(plugin.name, "pause");
    expect(paused.paused).toBe(true);
    expect(paused.run_requested_at).toBeNull();
    expect(await hosted(host, plugin.name)).toMatchObject({
      paused: true,
      run_requested_at: null,
    });

    const refused = await owner.controlConnector(plugin.name, "run");
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("connector_paused");
    expect(await control(plugin.name)).toMatchObject({
      paused: true,
      run_requested_at: null,
    });

    const resumed = await acted(plugin.name, "resume");
    expect(resumed.paused).toBe(false);
    expect(resumed.run_requested_at).toBeNull();
    expect(await hosted(host, plugin.name)).toMatchObject({ paused: false });

    const again = await acted(plugin.name, "run");
    await server.advanceClock(1_000);
    const later = await acted(plugin.name, "run");
    expect(Date.parse(later.run_requested_at)).toBeGreaterThan(
      Date.parse(again.run_requested_at),
    );
    expect((await control(plugin.name)).run_requested_at).toBe(
      later.run_requested_at,
    );
  });

  it("answers the connector's door to its own key and not to another plugin's key or a key without connectors.manage", async () => {
    const plugin = await installed(owner);
    const other = await installed(owner);
    const { client: own } = await connectorKey(server, plugin);
    const { client: foreign } = await connectorKey(server, other);

    expect((await control(plugin.name, own)).plugin).toBe(plugin.name);
    refusedForScope(await foreign.getConnectorControl(plugin.name));
    refusedForScope(await stranger.getConnectorControl(plugin.name));

    for (const by of [own, stranger]) {
      for (const act of ["pause", "resume", "run"] as const) {
        refusedForScope(await by.controlConnector(plugin.name, act));
      }
    }
    expect(await control(plugin.name)).toMatchObject({
      paused: false,
      run_requested_at: null,
    });
  });

  it("answers 404 for the door of a plugin not installed and of one with no connector", async () => {
    const missing = await owner.getConnectorControl(`absent-${fresh()}`);
    expect(missing.status).toBe(404);
    expect(missing.error?.error.code).toBe("plugin_not_found");

    const part = fresh();
    const bare = connectorBundle({
      name: `bare-${part}`,
      source: `bare${part}`,
      issue: `bare${part}.issue`,
      comment: `bare${part}.comment`,
      ticket: "",
    });
    delete bare.connector;
    const made = await owner.installPlugin(bare);
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const none = await owner.getConnectorControl(`bare-${part}`);
    expect(none.status).toBe(404);
    expect(none.error?.error.code).toBe("plugin_connector_not_found");
    const noPause = await owner.controlConnector(`bare-${part}`, "pause");
    expect(noPause.status).toBe(404);
    expect(noPause.error?.error.code).toBe("plugin_connector_not_found");
  });

  it("clears a run request when the connector reports a run that started at or after it, and not for one that started before", async () => {
    const plugin = await installed(owner);
    const { client: own } = await connectorKey(server, plugin);
    const registered = await own.registerConnector({ name: "Tracker" });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);

    const asked = (await acted(plugin.name, "run")).run_requested_at as string;
    const before = new Date(Date.parse(asked) - 1_000).toISOString();
    const earlier = await own.reportConnectorRun({
      outcome: "succeeded",
      started_at: before,
      finished_at: asked,
    } as never);
    expect(earlier.status, JSON.stringify(earlier.error)).toBe(201);
    expect((await control(plugin.name)).run_requested_at).toBe(asked);

    const at = await own.reportConnectorRun({
      outcome: "succeeded",
      started_at: asked,
      finished_at: asked,
    } as never);
    expect(at.status, JSON.stringify(at.error)).toBe(201);
    expect((await control(plugin.name)).run_requested_at).toBeNull();

    const next = (await acted(plugin.name, "run")).run_requested_at as string;
    const after = new Date(Date.parse(next) + 1_000).toISOString();
    const failed = await own.reportConnectorRun({
      outcome: "failed",
      started_at: after,
      finished_at: after,
      error: "the vendor was down",
    } as never);
    expect(failed.status, JSON.stringify(failed.error)).toBe(201);
    expect((await control(plugin.name)).run_requested_at).toBeNull();
  });

  it("takes the connector key's writes while the connector is paused", async () => {
    const plugin = await installed(owner);
    const { client: own } = await connectorKey(server, plugin);
    const registered = await own.registerConnector({ name: "Tracker" });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    // The witness: the key writes before the pause.
    await issue(own, plugin);

    await acted(plugin.name, "pause");
    const during = await issue(own, plugin);
    const read = await own.getItem(during.id);
    expect(read.status, JSON.stringify(read.error)).toBe(200);
    const updated = await own.updateItem(during.id, {
      version: read.data.item.version,
      properties: { title: "edited while paused" },
    });
    expect(updated.status, JSON.stringify(updated.error)).toBe(200);
    const now = new Date().toISOString();
    const run = await own.reportConnectorRun({
      outcome: "succeeded",
      started_at: now,
      finished_at: now,
    } as never);
    expect(run.status, JSON.stringify(run.error)).toBe(201);
    expect((await control(plugin.name)).paused).toBe(true);
  });

  it("audits a pause, a resume and a run request", async () => {
    const plugin = await installed(owner);
    await acted(plugin.name, "run");
    await acted(plugin.name, "pause");
    await acted(plugin.name, "resume");
    for (const action of [
      "connector.run_request",
      "connector.pause",
      "connector.resume",
    ]) {
      const entries = await owner.listAudit({
        action,
        resource_id: plugin.name,
      });
      expect(entries.status, JSON.stringify(entries.error)).toBe(200);
      expect(entries.data.data, action).toHaveLength(1);
      expect(entries.data.data[0]).toMatchObject({
        action,
        resource_type: "plugin",
        resource_id: plugin.name,
      });
    }
  });

  it("removes the pause, the run request and the previews with the plugin", async () => {
    const plugin = await installed(owner);
    await acted(plugin.name, "run");
    const preview = await previewed(plugin.name, { kind: "issue" });
    // The witness: the state stands before the plugin goes.
    expect(await control(plugin.name)).toMatchObject({ previews: 1 });
    expect((await control(plugin.name)).run_requested_at).not.toBeNull();

    const removed = await owner.removePlugin(plugin.name);
    expect(removed.status, JSON.stringify(removed.error)).toBe(200);
    const again = await owner.installPlugin(connectorBundle(plugin));
    expect(again.status, JSON.stringify(again.error)).toBe(201);
    expect(await control(plugin.name)).toMatchObject({
      paused: false,
      run_requested_at: null,
      previews: 0,
    });
    const gone = await owner.getMappingPreview(plugin.name, preview.id);
    expect(gone.status).toBe(404);
    expect(gone.error?.error.code).toBe("connector_preview_not_found");

    await acted(plugin.name, "pause");
    expect((await owner.removePlugin(plugin.name)).status).toBe(200);
    expect((await owner.installPlugin(connectorBundle(plugin))).status).toBe(
      201,
    );
    expect((await control(plugin.name)).paused).toBe(false);
  });
});

describe("mapping previews", () => {
  it("stores a preview pending, lists it to the connector's key and not to another plugin's key, and keeps the connector's answer as given", async () => {
    const plugin = await installed(owner);
    const other = await installed(owner);
    const { client: own } = await connectorKey(server, plugin);
    const { client: foreign } = await connectorKey(server, other);
    const item = await issue(own, plugin);

    const made = await owner.requestMappingPreview(plugin.name, {
      kind: "issue",
      item_id: item.id,
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    await expectMatchesSchema(
      "POST",
      "/plugins/{name}/connector/previews",
      201,
      made.data,
    );
    expect(made.data).toMatchObject({
      kind: "issue",
      item_id: item.id,
      mapping: null,
      status: "pending",
      result: null,
      error: null,
      answered_at: null,
    });
    expect(
      Date.parse(made.data.expires_at) - Date.parse(made.data.created_at),
    ).toBe(TEN_MINUTES_MS);

    const draft = await previewed(plugin.name, {
      kind: "issue",
      mapping: {
        target_type: plugin.ticket,
        fields: { title: { from: "title" }, reporter: { fixed: "tracker" } },
      },
    });
    expect(draft.mapping).toEqual({
      enabled: true,
      target_type: plugin.ticket,
      tier: "feed",
      status_overrides: {},
      fields: { title: { from: "title" }, reporter: { fixed: "tracker" } },
    });

    refusedForScope(
      await stranger.requestMappingPreview(plugin.name, { kind: "issue" }),
    );
    refusedForScope(
      await own.requestMappingPreview(plugin.name, { kind: "issue" }),
    );
    expect((await control(plugin.name)).previews).toBe(2);

    const listed = await own.listMappingPreviews(plugin.name, "pending");
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);
    await expectMatchesSchema(
      "GET",
      "/plugins/{name}/connector/previews",
      200,
      listed.data,
    );
    expect(listed.data.data.map((preview) => preview.id)).toEqual([
      made.data.id,
      draft.id,
    ]);
    expect(listed.data.next_cursor).toBeNull();
    expect(
      (await owner.listMappingPreviews(plugin.name)).data.data,
    ).toHaveLength(2);
    refusedForScope(await foreign.listMappingPreviews(plugin.name));
    refusedForScope(await stranger.listMappingPreviews(plugin.name));
    const badStatus = await own.listMappingPreviews(plugin.name, "done");
    expect(badStatus.status).toBe(400);
    expect(badStatus.error?.error.code).toBe("validation_error");

    const result = {
      title: "Hello",
      reporter: "tracker",
      nested: [1, { a: null }],
    };
    const ready = await own.answerMappingPreview(plugin.name, made.data.id, {
      result,
    });
    expect(ready.status, JSON.stringify(ready.error)).toBe(200);
    await expectMatchesSchema(
      "POST",
      "/plugins/{name}/connector/previews/{id}",
      200,
      ready.data,
    );
    expect(ready.data).toMatchObject({ status: "ready", result, error: null });
    expect(typeof ready.data.answered_at).toBe("string");

    const failed = await own.answerMappingPreview(plugin.name, draft.id, {
      error: "The template stopped at line 2.",
    });
    expect(failed.status, JSON.stringify(failed.error)).toBe(200);
    expect(failed.data).toMatchObject({
      status: "failed",
      result: null,
      error: "The template stopped at line 2.",
    });

    const read = await owner.getMappingPreview(plugin.name, made.data.id);
    expect(read.status, JSON.stringify(read.error)).toBe(200);
    await expectMatchesSchema(
      "GET",
      "/plugins/{name}/connector/previews/{id}",
      200,
      read.data,
    );
    expect(read.data).toEqual(ready.data);
    expect((await own.getMappingPreview(plugin.name, draft.id)).data).toEqual(
      failed.data,
    );
    refusedForScope(await stranger.getMappingPreview(plugin.name, draft.id));

    const twice = await own.answerMappingPreview(plugin.name, made.data.id, {
      result: { title: "Again" },
    });
    expect(twice.status).toBe(409);
    expect(twice.error?.error.code).toBe("connector_preview_answered");
    expect(
      (await owner.getMappingPreview(plugin.name, made.data.id)).data.result,
    ).toEqual(result);

    expect(
      (await own.listMappingPreviews(plugin.name, "pending")).data.data,
    ).toEqual([]);
    expect(
      (await own.listMappingPreviews(plugin.name, "ready")).data.data.map(
        (preview) => preview.id,
      ),
    ).toEqual([made.data.id]);
    expect((await own.listMappingPreviews(plugin.name)).data.data).toHaveLength(
      2,
    );
    expect((await control(plugin.name)).previews).toBe(0);
  });

  it("refuses a preview of an unknown kind, of an item outside the connector's source, and of a draft a save would refuse, naming each path", async () => {
    const plugin = await installed(owner);
    const { client: own } = await connectorKey(server, plugin);

    const unknown = await owner.requestMappingPreview(plugin.name, {
      kind: "nope",
    });
    expect(unknown.status).toBe(400);
    expect(paths(unknown.error)).toEqual(["kind"]);
    expect(
      paths((await owner.requestMappingPreview(plugin.name, {})).error),
    ).toEqual(["kind"]);
    const shape = await owner.requestMappingPreview(plugin.name, {
      kind: "issue",
      item_id: 5,
      mapping: "all",
      extra: true,
    });
    expect(shape.status).toBe(400);
    expect(shape.error?.error.code).toBe("validation_error");
    expect(paths(shape.error).sort()).toEqual(["extra", "item_id", "mapping"]);

    const owned = await owner.createItem({
      type: "core.note",
      properties: { title: "the owner's note" },
    });
    expect(owned.status, JSON.stringify(owned.error)).toBe(201);
    for (const itemId of [owned.data.item.id, randomUUID()]) {
      const outside = await owner.requestMappingPreview(plugin.name, {
        kind: "issue",
        item_id: itemId,
      });
      expect(outside.status).toBe(400);
      expect(outside.error?.error.code).toBe("validation_error");
      expect(paths(outside.error)).toEqual(["item_id"]);
    }

    const unfilled = await owner.requestMappingPreview(plugin.name, {
      kind: "issue",
      mapping: {
        target_type: plugin.ticket,
        fields: { title: { from: "title" } },
      },
    });
    expect(unfilled.status).toBe(400);
    expect(paths(unfilled.error)).toEqual(["mapping.fields.reporter"]);
    const tier = await owner.requestMappingPreview(plugin.name, {
      kind: "issue",
      mapping: { tier: "archive" },
    });
    expect(tier.status).toBe(400);
    expect(paths(tier.error)).toEqual(["mapping.tier"]);
    expect((await control(plugin.name)).previews).toBe(0);

    // The witness: an item the connector brought, and a draft a save takes, are taken.
    const item = await issue(own, plugin);
    await previewed(plugin.name, {
      kind: "issue",
      item_id: item.id,
      mapping: { tier: "library" },
    });
    expect((await control(plugin.name)).previews).toBe(1);
  });

  it("refuses a twenty-first pending preview 409 connector_previews_full, and takes one once the connector answers another", async () => {
    const plugin = await installed(owner);
    const { client: own } = await connectorKey(server, plugin);
    const made: string[] = [];
    for (let at = 0; at < 20; at += 1) {
      made.push((await previewed(plugin.name, { kind: "comment" })).id);
    }
    const full = await owner.requestMappingPreview(plugin.name, {
      kind: "comment",
    });
    expect(full.status).toBe(409);
    expect(full.error?.error.code).toBe("connector_previews_full");
    expect(full.error?.error.details?.limit).toBe(20);
    expect(
      (await own.listMappingPreviews(plugin.name, "pending")).data.data,
    ).toHaveLength(20);

    const answered = await own.answerMappingPreview(plugin.name, made[0]!, {
      error: "No comment to render.",
    });
    expect(answered.status, JSON.stringify(answered.error)).toBe(200);
    await previewed(plugin.name, { kind: "comment" });
    expect((await control(plugin.name)).previews).toBe(20);
  });

  it("refuses an answer of the wrong shape, an oversized result and an answer from another key, and changes nothing", async () => {
    const plugin = await installed(owner);
    const other = await installed(owner);
    const { client: own } = await connectorKey(server, plugin);
    const { client: foreign } = await connectorKey(server, other);
    const preview = await previewed(plugin.name, { kind: "issue" });

    for (const [body, named] of [
      [{}, null],
      [{ result: {}, error: "both" }, null],
      [{ result: [1] }, ["result"]],
      [{ error: "" }, ["error"]],
      [{ error: "x".repeat(501) }, ["error"]],
      [{ result: {}, extra: 1 }, ["extra"]],
      [{ result: { text: "a".repeat(70_000) } }, ["result"]],
    ] as const) {
      const refused = await own.answerMappingPreview(
        plugin.name,
        preview.id,
        body,
      );
      expect(refused.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      if (named !== null) expect(paths(refused.error)).toEqual(named);
    }

    for (const by of [foreign, owner, stranger]) {
      const refused = await by.answerMappingPreview(plugin.name, preview.id, {
        result: { title: "not yours" },
      });
      expect(refused.status).toBe(403);
      expect(refused.error?.error.code).toBe("forbidden");
    }
    expect(
      (await owner.getMappingPreview(plugin.name, preview.id)).data.status,
    ).toBe("pending");

    // The witness: a result under the bound is kept as given.
    const large = { text: "a".repeat(60_000) };
    const kept = await own.answerMappingPreview(plugin.name, preview.id, {
      result: large,
    });
    expect(kept.status, JSON.stringify(kept.error)).toBe(200);
    expect(kept.data.result).toEqual(large);
  });

  it(
    "answers 404 connector_preview_not_found for a preview once 10 minutes have passed, and lists it no longer",
    // The test moves the server's clock, which a second run cannot move back.
    { retry: 0 },
    async () => {
      const plugin = await installed(owner);
      const { client: own } = await connectorKey(server, plugin);
      const preview = await previewed(plugin.name, { kind: "issue" });
      const unknown = await owner.getMappingPreview(plugin.name, randomUUID());
      expect(unknown.status).toBe(404);
      expect(unknown.error?.error.code).toBe("connector_preview_not_found");

      await server.advanceClock(TEN_MINUTES_MS - 2_000);
      // The witness: just before its end the preview is read and listed.
      expect(
        (await owner.getMappingPreview(plugin.name, preview.id)).status,
      ).toBe(200);
      expect(
        (await own.listMappingPreviews(plugin.name)).data.data.map(
          (held) => held.id,
        ),
      ).toEqual([preview.id]);

      await server.advanceClock(3_000);
      const gone = await owner.getMappingPreview(plugin.name, preview.id);
      expect(gone.status).toBe(404);
      expect(gone.error?.error.code).toBe("connector_preview_not_found");
      const late = await own.answerMappingPreview(plugin.name, preview.id, {
        result: { title: "too late" },
      });
      expect(late.status).toBe(404);
      expect(late.error?.error.code).toBe("connector_preview_not_found");
      expect((await own.listMappingPreviews(plugin.name)).data.data).toEqual(
        [],
      );
      expect((await control(plugin.name)).previews).toBe(0);
    },
  );
});

describe("an archive", () => {
  it("carries no pause, run request or preview in an archive, and a restore leaves the connector running with none", async () => {
    const plugin = await installed(owner);
    await acted(plugin.name, "run");
    const preview = await previewed(plugin.name, { kind: "issue" });
    const asked = await owner.exportArchive({ state: "any" });
    expect(asked.status).toBe(200);
    await acted(plugin.name, "pause");
    const paused = await owner.exportArchive({ state: "any" });
    expect(paused.status).toBe(200);

    for (const archive of [asked.data, paused.data]) {
      const lines = archiveLines(archive, "instance");
      // The witness: the archive carries the plugin whose state it leaves out.
      expect(
        lines.some(
          (line) =>
            "plugin" in line &&
            (line.plugin as { name?: string } | undefined)?.name ===
              plugin.name,
        ),
      ).toBe(true);
      const text = JSON.stringify(lines);
      expect(text).not.toContain("run_requested_at");
      expect(text).not.toContain('"paused"');
      expect(text).not.toContain(preview.id);
    }

    const restored = await local(destination).restoreArchive(paused.data);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(await control(plugin.name, local(destination))).toMatchObject({
      paused: false,
      run_requested_at: null,
      previews: 0,
    });
  });
});

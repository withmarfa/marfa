import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  archiveLines,
  archiveManifest,
  editLineFile,
  itemsArchive,
} from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { clientsFor, DISK_ONLY } from "../../utils/own-blob-server.js";

/**
 * What an archive carries of the instance beside its rows: stored settings,
 * connector state and agreements, each only to a credential that manages it,
 * and never a webhook, a secret or an address the instance answers at; and
 * what a restore does with them: sets what the instance lacks, replacing
 * nothing it holds.
 */

let server: FreshServer;
let operator: MarfaClient;
let working: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("export-instance-lines", DISK_ONLY);
  ({ operator, working } = clientsFor(server));
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

interface InstanceLine {
  setting?: { key: string; value: unknown };
  connector_state?: { source: string; state: Record<string, unknown> };
  connector_agreement?: {
    source: string;
    item_id: string;
    waiting: boolean;
    record: Record<string, unknown>;
  };
  webhook?: unknown;
}

describe("the instance lines of an archive", () => {
  it("carries the instance's settings, connector state and agreements to a credential that manages them, and none to one that does not", async () => {
    const owner = new MarfaClient({
      baseUrl: server.apiUrl,
      controlSocket: server.controlSocket,
    });
    const set = await operator.patchConfig({ audit_retention_days: 31 });
    expect(set.status, JSON.stringify(set.error)).toBe(200);
    const moved = await owner.patchConfig({
      addresses: [new URL(server.apiUrl).origin, "https://marfa.example"],
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);

    const note = await working.createItem({
      type: "core.note",
      properties: { title: "agreed" },
    });
    expect(note.status, JSON.stringify(note.error)).toBe(201);
    const connector = await working.registerConnector({ name: "export lines" });
    expect(connector.status, JSON.stringify(connector.error)).toBe(201);
    const process = "export-lines";
    const held = await working.takeConnectorHold(connector.data.id, process);
    expect(held.status, JSON.stringify(held.error)).toBe(200);
    const state = await working.replaceConnectorState(connector.data.id, {
      process,
      state: { cursor: "c1" },
    });
    expect(state.status, JSON.stringify(state.error)).toBe(200);
    const agreed = await working.writeConnectorAgreements(connector.data.id, {
      process,
      set: [
        { item_id: note.data.item.id, waiting: false, record: { etag: "e1" } },
      ],
    });
    expect(agreed.status, JSON.stringify(agreed.error)).toBe(200);

    const hook = await operator.createWebhook({
      url: "https://hooks.example/export-lines",
      events: ["item.created"],
    });
    expect(hook.status, JSON.stringify(hook.error)).toBe(201);

    const whole = await operator.exportArchive();
    expect(whole.status).toBe(200);
    const lines = archiveLines<InstanceLine>(whole.data, "instance");
    const settings = lines.flatMap((line) =>
      line.setting ? [line.setting] : [],
    );
    expect(settings).toContainEqual({ key: "audit_retention_days", value: 31 });
    expect(settings.map((one) => one.key)).not.toContain("addresses");
    expect(settings.map((one) => one.key)).not.toContain("sign_in_address");
    expect(lines.map((line) => line.connector_state)).toContainEqual({
      source: connector.data.source,
      state: { cursor: "c1" },
    });
    expect(lines.map((line) => line.connector_agreement)).toContainEqual({
      source: connector.data.source,
      item_id: note.data.item.id,
      waiting: false,
      record: { etag: "e1" },
    });
    // The witness for the webhook's absence: the instance holds one.
    expect(lines.filter((line) => line.webhook !== undefined)).toEqual([]);
    expect(JSON.stringify(lines)).not.toContain(hook.data.id);
    const manifest = archiveManifest<Record<string, number>>(whole.data);
    expect(manifest.setting_count).toBe(settings.length);
    expect(manifest.connector_state_count).toBe(1);
    expect(manifest.connector_agreement_count).toBe(1);
    expect(manifest).not.toHaveProperty("webhook_count");

    const narrow = await working.createKey({
      label: "export-lines-narrow",
      source: "export-lines-narrow",
      permissions: [],
      type_permissions: { "core.note": "read" },
    });
    expect(narrow.status, JSON.stringify(narrow.error)).toBe(201);
    const reader = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: narrow.data.key,
    });
    const partial = await reader.exportArchive();
    expect(partial.status).toBe(200);
    expect(
      archiveLines<{ item: { id: string } }>(partial.data, "items").map(
        (line) => line.item.id,
      ),
    ).toContain(note.data.item.id);
    const kept = archiveLines<InstanceLine>(partial.data, "instance");
    for (const kind of [
      "setting",
      "connector_state",
      "connector_agreement",
    ] as const) {
      expect(
        kept.filter((line) => line[kind] !== undefined),
        kind,
      ).toEqual([]);
    }
  });
  it("restores the settings, connector state and agreements the instance lacks, and replaces none it holds", async () => {
    const owner = new MarfaClient({
      baseUrl: server.apiUrl,
      controlSocket: server.controlSocket,
    });
    for (const [key, value] of [
      ["trash_retention_days", 45],
      ["event_log_retention_hours", 500],
    ] as const) {
      const set = await operator.patchConfig({ [key]: value });
      expect(set.status, JSON.stringify(set.error)).toBe(200);
    }
    const note = await working.createItem({
      type: "core.note",
      properties: { title: "agreed again" },
    });
    expect(note.status, JSON.stringify(note.error)).toBe(201);
    const cleared = await working.createItem({
      type: "core.note",
      properties: { title: "agreed, then cleared" },
    });
    expect(cleared.status, JSON.stringify(cleared.error)).toBe(201);
    const listed = await working.listConnectors();
    const connector = listed.data.data[0]!;
    const process = "export-lines";
    expect(
      (await working.takeConnectorHold(connector.id, process)).status,
    ).toBe(200);
    expect(
      (
        await working.replaceConnectorState(connector.id, {
          process,
          state: { cursor: "archived" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await working.writeConnectorAgreements(connector.id, {
          process,
          set: [
            {
              item_id: note.data.item.id,
              waiting: true,
              record: { etag: "a" },
            },
            {
              item_id: cleared.data.item.id,
              waiting: false,
              record: { etag: "c" },
            },
          ],
        })
      ).status,
    ).toBe(200);
    const archive = await operator.exportArchive({ state: "any" });
    expect(archive.status).toBe(200);

    // Since the export: one setting is cleared and one changed, the state is
    // cleared and the agreement changed.
    expect(
      (await operator.patchConfig({ trash_retention_days: null })).status,
    ).toBe(200);
    expect(
      (await operator.patchConfig({ event_log_retention_hours: 600 })).status,
    ).toBe(200);
    expect((await working.deleteConnectorState(connector.id)).status).toBe(200);
    expect(
      (
        await working.writeConnectorAgreements(connector.id, {
          process,
          set: [
            {
              item_id: note.data.item.id,
              waiting: false,
              record: { etag: "b" },
            },
          ],
          clear: [cleared.data.item.id],
        })
      ).status,
    ).toBe(200);

    const restored = await owner.restoreArchive(archive.data);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.settings_added).toBe(1);
    expect(restored.data.settings_skipped).toBeGreaterThanOrEqual(1);
    expect(restored.data.connector_states_added).toBe(1);
    // Clearing the state cleared the source's agreements, so the one the
    // first case wrote comes back beside the cleared one.
    expect(restored.data.connector_agreements_added).toBe(2);
    expect(restored.data.connector_agreements_skipped).toBeGreaterThanOrEqual(
      1,
    );

    const config = await operator.getConfig();
    const value = (key: string) =>
      (config.data as unknown as Record<string, { value?: unknown }>)[key]
        ?.value ?? (config.data as unknown as Record<string, unknown>)[key];
    expect(value("trash_retention_days")).toBe(45);
    expect(value("event_log_retention_hours")).toBe(600);
    const state = await working.getConnectorState(connector.id);
    expect(state.data.state).toEqual({ cursor: "archived" });
    const agreed = await working.lookupConnectorAgreements(connector.id, [
      note.data.item.id,
      cleared.data.item.id,
    ]);
    expect(JSON.stringify(agreed.data)).toContain('"etag":"b"');
    expect(JSON.stringify(agreed.data)).toContain('"etag":"c"');
    expect(JSON.stringify(agreed.data)).not.toContain('"etag":"a"');
  });

  it("refuses settings the instance cannot hold together, answering as /config does, and stores none", async () => {
    const owner = new MarfaClient({
      baseUrl: server.apiUrl,
      controlSocket: server.controlSocket,
    });
    const withSettings = (settings: Record<string, unknown>) =>
      editLineFile(itemsArchive([]), "instance", (text) =>
        Object.entries(settings).reduce(
          (lines, [key, value]) =>
            `${lines}${JSON.stringify({ setting: { key, value } })}\n`,
          text,
        ),
      );
    for (const settings of [
      { heartbeat_enabled: true },
      { version_daily_snapshot_days: 7 },
    ]) {
      const configured = await operator.patchConfig(settings);
      // The witness: /config refuses the same settings on this instance.
      expect(configured.status, JSON.stringify(configured.data)).toBe(400);
      const refused = await owner.restoreArchive(withSettings(settings));
      expect(refused.status, JSON.stringify(refused.data)).toBe(400);
      expect(refused.error?.error.code).toBe(configured.error?.error.code);
      expect(refused.error?.error.details?.errors).toEqual(
        configured.error?.error.details?.errors,
      );
      const config = (await operator.getConfig()).data as unknown as Record<
        string,
        unknown
      >;
      for (const key of Object.keys(settings)) {
        expect(config[key]).toBeUndefined();
      }
    }

    const restored = await owner.restoreArchive(
      withSettings({
        version_recent_days: 7,
        version_daily_snapshot_days: 7,
        version_weekly_snapshot_days: 14,
      }),
    );
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.settings_added).toBe(3);
  });

  it("refuses an archive that carries one setting twice, and stores neither value", async () => {
    const owner = new MarfaClient({
      baseUrl: server.apiUrl,
      controlSocket: server.controlSocket,
    });
    const key = "revoked_grant_retention_days";
    const before = (await operator.getConfig()).data as unknown as Record<
      string,
      unknown
    >;
    // The witness: the instance holds no value of its own for the setting.
    expect(before[key]).toBeUndefined();
    const withValues = (...values: number[]) =>
      editLineFile(itemsArchive([]), "instance", (text) =>
        values.reduce(
          (lines, value) =>
            `${lines}${JSON.stringify({ setting: { key, value } })}\n`,
          text,
        ),
      );

    const refused = await owner.restoreArchive(withValues(40, 50));
    expect(refused.status, JSON.stringify(refused.data)).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(refused.error?.error.message).toContain(key);
    const after = (await operator.getConfig()).data as unknown as Record<
      string,
      unknown
    >;
    expect(after[key]).toBeUndefined();

    const restored = await owner.restoreArchive(withValues(40));
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.settings_added).toBe(1);
  });
});

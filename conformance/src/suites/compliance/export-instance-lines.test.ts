import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { archiveLines, archiveManifest } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { clientsFor, DISK_ONLY } from "../../utils/own-blob-server.js";

/**
 * What an archive carries of the instance beside its rows: stored settings,
 * connector state and agreements, and webhook subscriptions, each only to a
 * credential that manages it, and never a secret or an address the instance
 * answers at.
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
  webhook?: { id: string; url: string; secret?: unknown };
}

describe("the instance lines of an archive", () => {
  it("carries the instance's settings, connector state, agreements and webhooks to a credential that manages them, and none to one that does not", async () => {
    const owner = new MarfaClient({
      baseUrl: server.apiUrl,
      ownerCookie: server.ownerCookie,
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

    const whole = await owner.exportArchive();
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
    const webhooks = lines.flatMap((line) =>
      line.webhook ? [line.webhook] : [],
    );
    expect(webhooks).toContainEqual(
      expect.objectContaining({
        id: hook.data.id,
        url: "https://hooks.example/export-lines",
      }),
    );
    expect(JSON.stringify(lines)).not.toContain(hook.data.secret);
    const manifest = archiveManifest<Record<string, number>>(whole.data);
    expect(manifest.setting_count).toBe(settings.length);
    expect(manifest.connector_state_count).toBe(1);
    expect(manifest.connector_agreement_count).toBe(1);
    expect(manifest.webhook_count).toBe(webhooks.length);

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
      "webhook",
    ] as const) {
      expect(
        kept.filter((line) => line[kind] !== undefined),
        kind,
      ).toEqual([]);
    }
  });
});

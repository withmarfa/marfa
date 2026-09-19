import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { MarfaItem, TestContext } from "../../client/types.js";
import {
  createTestContext,
  getOperatorClient,
  trackItem,
  trackEdge,
  cleanup,
} from "../../utils/setup.js";
import { createNote, generateId } from "../../generators/items.js";
import { itemsArchive } from "../../utils/archive.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
/** The restore door is operator-only, and it is what mints the mirror. */
let operator: MarfaClient;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "promote-reconcile",
  ));
  operator = getOperatorClient();
});

afterAll(async () => {
  await cleanup(ctx);
});

/**
 * Both doors act on an item that is a connector's copy.
 *
 * **Which a caller can create, and this file used to say it could not.** No
 * connector runs on the server under test and no write door mints such a
 * row: `POST /keys` refuses the `connector:` prefix as a credential source,
 * and `POST /items` stamps the credential's own source over anything the
 * body claims. `POST /admin/restore-archive` is the door that does not —
 * it writes `item.source` through verbatim — so an archive carrying the
 * prefix mints the mirror, and the success paths behind that precondition
 * are assertable after all. Both were recorded as unassertable in
 * `coverage.md` and `items.md` for as long as nobody tried the third door.
 */
/** One entry of `GET /items/{id}/reconcile`'s answer. */
interface ReconciledMirror {
  mirror_id: string;
  mirror_type: string;
  mirror_source: string;
  mirror_updated_at: string;
  fields: { key: string; state: string; yours?: unknown; mirror?: unknown }[];
}

/** The provenance only an archive can put on a row. */
function connectorSource(label: string): string {
  return `connector:conformance/${ctx.runId}-${label}`;
}

/**
 * Write a connector's copy and hand back its id.
 *
 * Through `POST /admin/restore-archive` because that is the only door that
 * does not stamp the caller's own provenance over the body's. The id is
 * minted here so the row can be addressed without a lookup; the restore
 * writes it through as it does the source.
 */
async function seedMirror(label: string): Promise<string> {
  const id = generateId();
  const restored = await operator.restoreArchive(
    itemsArchive([
      {
        id,
        type: "core.note",
        properties: {
          title: "Upstream record",
          body: "as the connector saw it",
        },
        source: connectorSource(label),
      },
    ]),
  );
  expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
  expect(restored.data.imported).toBe(1);
  trackItem(ctx, id);
  return id;
}

describe("promote and reconcile", () => {
  it("refuses to promote an item that is already the caller's own", async () => {
    const item = await client.createItem(createNote({ source: ctx.source }));
    expect(item.ok).toBe(true);
    trackItem(ctx, item.data.item.id);

    const r = await client.promoteItem(item.data.item.id);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("validation_error");
    expect(r.error?.error.details?.item_id).toBe(item.data.item.id);

    const unchanged = await client.getItem(item.data.item.id);
    expect(unchanged.ok).toBe(true);
    expect(unchanged.data.item.version).toBe(1);
  });

  it("refuses to reconcile an item that was never promoted", async () => {
    const item = await client.createItem(createNote({ source: ctx.source }));
    expect(item.ok).toBe(true);
    trackItem(ctx, item.data.item.id);

    const r = await client.reconcileItem(item.data.item.id);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("validation_error");
    expect(r.error?.error.details?.item_id).toBe(item.data.item.id);
  });

  it("answers 404 for an unknown item on both doors", async () => {
    const unknown = "00000000-0000-7000-8000-000000000000";
    const promote = await client.promoteItem(unknown);
    expect(promote.status).toBe(404);
    expect(promote.error?.error.code).toBe("item_not_found");
    const reconcile = await client.reconcileItem(unknown);
    expect(reconcile.status).toBe(404);
    expect(reconcile.error?.error.code).toBe("item_not_found");
  });

  it("refuses both doors without a credential", async () => {
    const item = await client.createItem(createNote({ source: ctx.source }));
    expect(item.ok).toBe(true);
    trackItem(ctx, item.data.item.id);
    const anonymous = new MarfaClient({ baseUrl: apiUrl, apiKey: "" });
    for (const refused of [
      await anonymous.promoteItem(item.data.item.id),
      await anonymous.reconcileItem(item.data.item.id),
    ]) {
      expect(refused.status).toBe(401);
      expect(refused.error?.error.code).toBe("unauthorized");
    }
  });

  it("restores a connector's copy, which no write door can create", async () => {
    // The precondition the other cases in this file could not arrange, and
    // the three claims that follow from it. Asserted as one body because
    // the mirror is the fixture: splitting it would restore three of them.
    const mirrorId = await seedMirror("reachable");

    // 1. It reads back carrying the connector's provenance, not the
    //    caller's. `POST /items` would have stamped `ctx.source` here.
    const read = await client.getItem(mirrorId);
    expect(read.ok).toBe(true);
    expect(read.data.item.source).toBe(connectorSource("reachable"));

    // 2. A property write on it is refused `403 connector_owned` — a code
    //    the document declared nowhere until this fixture reached it.
    const patched = await client.updateItem(mirrorId, {
      version: read.data.item.version,
      properties: { body: "mine now" },
    });
    expect(patched.status).toBe(403);
    expect(patched.error?.error.code).toBe("connector_owned");
    expect(patched.error?.error.details?.item_id).toBe(mirrorId);
    await expectMatchesSchema("PATCH", "/items/{id}", 403, patched.error);
    const unchanged = await client.getItem(mirrorId);
    expect(unchanged.data.item.version).toBe(read.data.item.version);
    expect(unchanged.data.item.properties.body).toBe(
      read.data.item.properties.body,
    );

    // 3. Promote mints the caller's own copy, joined back by `derived-from`,
    //    and reconcile then answers over that join. Both are the success
    //    paths `coverage.md` recorded as unreachable.
    const promoted = await client.promoteItem(mirrorId);
    expect(promoted.status).toBe(201);
    trackItem(ctx, promoted.data.item.id);
    await expectMatchesSchema(
      "POST",
      "/items/{id}/promote",
      201,
      promoted.data,
    );
    expect(promoted.data.item.id).not.toBe(mirrorId);
    expect(promoted.data.item.source).toBe(ctx.source);
    expect(promoted.data.item.properties).toEqual(read.data.item.properties);

    const hydrated = await client.rawRequest<{ item: MarfaItem }>(
      `/items/${promoted.data.item.id}?include=edges`,
    );
    expect(hydrated.ok).toBe(true);
    const joined = hydrated.data.item.edges?.["derived-from"]?.edges ?? [];
    expect(joined.map((edge) => edge.target_id)).toEqual([mirrorId]);
    for (const edge of joined) trackEdge(ctx, edge.id);

    // The promoted copy is editable, which is the whole point of promoting.
    const mine = await client.updateItem(promoted.data.item.id, {
      version: promoted.data.item.version,
      properties: { body: "mine now" },
    });
    expect(mine.ok).toBe(true);

    const reconciled = await client.rawRequest<{ mirrors: ReconciledMirror[] }>(
      `/items/${promoted.data.item.id}/reconcile`,
    );
    expect(reconciled.status).toBe(200);
    await expectMatchesSchema(
      "GET",
      "/items/{id}/reconcile",
      200,
      reconciled.data,
    );
    const mirrors = reconciled.data.mirrors;
    expect(mirrors.map((m) => m.mirror_id)).toEqual([mirrorId]);
    expect(mirrors[0].mirror_source).toBe(connectorSource("reachable"));
    // The field the promoted copy diverged on is reported as diverged, which
    // is what a comparison door is for. The other two are still `same`.
    const body = mirrors[0].fields.find((f) => f.key === "body");
    expect(body?.state).not.toBe("same");
    expect(mirrors[0].fields.find((f) => f.key === "title")?.state).toBe(
      "same",
    );
  });
});

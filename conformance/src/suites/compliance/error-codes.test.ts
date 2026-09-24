import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type {
  AncestorUnavailableResponse,
  ConflictResponse,
  TestContext,
} from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "error-codes",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("error codes", () => {
  describe("MISSING_REQUIRED_FIELD", () => {
    it("rejects item without type", async () => {
      const response = await client.createItem({
        type: undefined as unknown as string,
      });
      expect(response.status).toBe(400);
      expect(response.error?.error.code).toBe("missing_required_field");
    });
  });

  describe("validation_error on a malformed type identifier", () => {
    it("rejects item with malformed type identifier", async () => {
      const response = await client.createItem({
        type: "invalid type with spaces",
      });
      expect(response.status).toBe(400);
      expect(response.error?.error.code).toBe("validation_error");
      // The field, which is what a generic code has to carry to be useful:
      // without it a caller cannot tell this from a body wrong elsewhere.
      const errors = response.error?.error.details?.errors as
        { path: string }[] | undefined;
      expect(errors?.[0]?.path).toBe("type");
    });
  });

  describe("invalid_id", () => {
    it("rejects request with malformed ID", async () => {
      const response = await client.getItem("not-a-valid-uuid");
      expect(response.status).toBe(400);
      expect(response.error?.error.code).toBe("invalid_id");
    });
  });

  // A duplicate (source, source_id) pair on POST /items is a natural-key
  // upsert, so there is no duplicate-source refusal to pin; the upsert is
  // asserted in correctness/dedup.test.ts.

  describe("item_not_found", () => {
    it("returns 404 for non-existent item", async () => {
      const response = await client.getItem(
        "00000000-0000-7000-8000-000000000000",
      );
      expect(response.status).toBe(404);
      expect(response.error?.error.code).toBe("item_not_found");
    });
  });

  describe("ancestor_unavailable", () => {
    it("rejects an update naming a version that never existed", async () => {
      const note = createNote({ source: ctx.source });
      const r = await client.createItem(note);
      expect(r.ok).toBe(true);
      trackItem(ctx, r.data.item.id);

      // No snapshot exists for version 999, so there is no ancestor to merge
      // against and the write cannot be a version conflict.
      const updated = await client.updateItem(r.data.item.id, {
        properties: { title: "Conflict test" },
        version: 999,
      });
      expect(updated.status).toBe(409);
      expect(updated.error?.error.code).toBe("ancestor_unavailable");
      const body = updated.error as unknown as AncestorUnavailableResponse;
      expect(body.error.status).toBe(409);
      expect(body.requested_version).toBe(999);
      expect(body.current.version).toBe(1);
      expect(body).not.toHaveProperty("ancestor");
      expect(body).not.toHaveProperty("conflicting_fields");
    });
  });

  describe("version_conflict", () => {
    it("rejects a stale write whose base version is retained", async () => {
      const note = createNote({
        source: ctx.source,
        properties: { title: "first", body: "body" },
      });
      const r = await client.createItem(note);
      expect(r.ok).toBe(true);
      trackItem(ctx, r.data.item.id);

      const advanced = await client.updateItem(r.data.item.id, {
        properties: { title: "second" },
        version: 1,
      });
      expect(advanced.ok).toBe(true);
      expect(advanced.data.item.version).toBe(2);

      const stale = await client.updateItem(r.data.item.id, {
        properties: { title: "third" },
        version: 1,
      });
      expect(stale.status).toBe(409);
      expect(stale.error?.error.code).toBe("version_conflict");
      const body = stale.error as unknown as ConflictResponse;
      expect(body.error.status).toBe(409);
      expect(body.current.version).toBe(2);
      expect(body.ancestor.version).toBe(1);
      expect(body.ancestor.properties.title).toBe("first");
      expect(body.conflicting_fields).toEqual(["title"]);
      expect(body.merge_policy.default).toBe("last_writer_wins");
    });
  });

  describe("invalid transition", () => {
    it("rejects invalid lifecycle transition", async () => {
      const note = createNote({ source: ctx.source });
      const r = await client.createItem(note);
      expect(r.ok).toBe(true);
      trackItem(ctx, r.data.item.id);

      const invalid = await client.transitionItem(
        r.data.item.id,
        "nonexistent",
      );
      expect(invalid.status).toBe(400);
      expect(invalid.error?.error.code).toBe("validation_error");
    });
  });

  describe("unauthorized", () => {
    it("rejects requests without auth", async () => {
      const noAuthClient = new MarfaClient({
        baseUrl: apiUrl,
        apiKey: "",
      });
      const response = await noAuthClient.listItems();
      expect(response.status).toBe(401);
      expect(response.error?.error.code).toBe("unauthorized");
    });

    it("rejects requests with invalid key", async () => {
      const badClient = new MarfaClient({
        baseUrl: apiUrl,
        apiKey: "invalid-key-that-does-not-exist",
      });
      const response = await badClient.listItems();
      expect(response.status).toBe(401);
      expect(response.error?.error.code).toBe("unauthorized");
    });
  });

  describe("blob_not_found", () => {
    it("returns 404 for non-existent blob", async () => {
      const response = await client.downloadBlob(
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      );
      expect(response.status).toBe(404);
      expect(response.error?.error.code).toBe("blob_not_found");
    });
  });

  describe("provenance_collision", () => {
    it("is declared by no door, because nothing raises it", async () => {
      // The code was mapped to 409 and declared on five doors while no code
      // path ever threw it, so three published refusals described a gesture
      // the server never refuses. Nothing over the wire can produce it, so
      // the only assertable claim is its absence from the document, and the
      // whole document is searched rather than the five doors it sat on:
      // the defect was a declaration nobody could reach, and a new one would
      // be just as unreachable wherever it landed.
      const response = await fetch(`${apiUrl}/openapi.json`);
      expect(response.status).toBe(200);
      const document = await response.text();
      expect(document).not.toContain("provenance_collision");
    });
  });

  describe("type_not_permitted", () => {
    it("rejects creation of out-of-scope type", async () => {
      const keyResp = await client.createKey({
        label: "bookmark-only",
        source: `${ctx.source}-${"bookmark-only"}`,
        type_permissions: { "core.bookmark": "write" },
      });
      expect(keyResp.ok).toBe(true);
      trackKey(ctx, keyResp.data.id);

      const scopedClient = new MarfaClient({
        baseUrl: apiUrl,
        apiKey: keyResp.data.key,
      });

      const noteResp = await scopedClient.createItem(createNote());
      expect(noteResp.status).toBe(403);
      expect(noteResp.error?.error.code).toBe("type_not_permitted");
    });
  });
});

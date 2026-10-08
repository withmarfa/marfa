import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v7 as uuidv7 } from "uuid";
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
import { servedDocument } from "../../utils/openapi.js";
import { SPEC_DIR } from "../../utils/spec-statements.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
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
      expect(response.error?.error.details).toMatchObject({ field: "type" });
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

type Fill = "unknown" | "well-formed" | "malformed";

/**
 * Bodies a published door takes whatever they hold, so the refusal this test
 * looks for never comes and the request would write.
 */
const TAKES_ANY_BODY: Record<string, string> = {
  "POST /blobs": "the bytes of a blob",
  "PUT /config": "an empty object is an update that changes nothing",
};

/** The codes in the table at the end of `spec/errors.md`. */
function tableCodes(): Set<string> {
  const chapter = readFileSync(resolve(SPEC_DIR, "errors.md"), "utf8");
  const start = chapter.indexOf("<!-- errors-table:start -->");
  const end = chapter.indexOf("<!-- errors-table:end -->");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return new Set(
    [...chapter.slice(start, end).matchAll(/^\| `([a-z_]+)`\s*\|/gm)].map(
      (row) => row[1] as string,
    ),
  );
}

describe("every refusal's code", () => {
  it("answers every refusal across the published operations with a code from the table", async () => {
    const table = tableCodes();
    expect(table.size).toBeGreaterThan(40);

    const operator = process.env.MARFA_MANAGEMENT_KEY;
    expect(operator, "MARFA_MANAGEMENT_KEY is required").toBeTruthy();
    const narrowed = await client.createKey({
      label: `${ctx.source}-narrowed`,
      source: `${ctx.source}-narrowed`,
      type_permissions: { "core.note": "read" },
    });
    expect(narrowed.status, JSON.stringify(narrowed.error)).toBe(201);
    trackKey(ctx, narrowed.data.id);

    const document = await servedDocument();
    const doors: { method: string; template: string; reads: boolean }[] = [];
    for (const [template, item] of Object.entries(document.paths)) {
      // The sign-in library answers these in its own shapes.
      if (template.startsWith("/auth/")) continue;
      for (const [method, operation] of Object.entries(item)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) {
          continue;
        }
        if (JSON.stringify(operation).includes("text/event-stream")) continue;
        doors.push({
          method: method.toUpperCase(),
          template,
          reads: method === "get",
        });
      }
    }
    expect(doors.length).toBeGreaterThan(90);

    /**
     * A path with each parameter filled in with a value the instance holds
     * nothing under: an unknown identifier, one in the shape the parameter
     * takes, or one in no shape.
     */
    const filled = (template: string, fill: Fill) =>
      template.replace(/\{([^}]+)\}/g, (_, name: string) => {
        if (fill === "malformed") return "not-a-valid-id";
        if (name === "hash") {
          return fill === "well-formed" ? `sha256:${"0".repeat(64)}` : uuidv7();
        }
        const named = !["id", "endpoint_id", "delivery_id"].includes(name);
        return fill === "well-formed" && named ? "unknown-name" : uuidv7();
      });

    const jsonType = { "Content-Type": "application/json" };
    const bodies: {
      name: string;
      headers: Record<string, string>;
      body?: string;
    }[] = [
      { name: "no body", headers: {} },
      { name: "a body that is not JSON", headers: jsonType, body: "[" },
      { name: "an array", headers: jsonType, body: "[]" },
      { name: "an empty object", headers: jsonType, body: "{}" },
      {
        name: "an undeclared member",
        headers: jsonType,
        body: JSON.stringify({ undeclared_member: true }),
      },
      {
        name: "text",
        headers: { "Content-Type": "text/plain" },
        body: "{}",
      },
    ];
    const credentials: {
      name: string;
      headers: Record<string, string>;
      bodies: number[];
    }[] = [
      { name: "no credential", headers: {}, bodies: [0, 3] },
      {
        name: "an unknown key",
        headers: { Authorization: "Bearer not-a-key-the-server-issued" },
        bodies: [0, 3],
      },
      {
        name: "a key",
        headers: { Authorization: `Bearer ${apiKey}` },
        bodies: [0, 1, 2, 3, 4, 5],
      },
      {
        name: "a key that may only read notes",
        headers: { Authorization: `Bearer ${narrowed.data.key}` },
        bodies: [0, 3, 4],
      },
      {
        // This credential can manage the instance, so send only bodies
        // that cannot be accepted as an object.
        name: "a key holding management grants",
        headers: { Authorization: `Bearer ${operator!}` },
        bodies: [0, 1, 2],
      },
    ];
    const queries = ["", "?undeclared_query_key=1"];
    const readViews: (string | undefined)[] = [undefined, "not-a-proof"];

    const seen = new Map<string, number>();
    const outside: string[] = [];
    const wrote: string[] = [];
    let refusals = 0;
    for (const door of doors) {
      for (const fill of ["unknown", "well-formed", "malformed"] as const) {
        for (const credential of credentials) {
          for (const bodyIndex of credential.bodies) {
            const body = bodies[bodyIndex]!;
            if (door.reads && bodyIndex > 0) continue;
            if (`${door.method} ${door.template}` in TAKES_ANY_BODY) {
              if (bodyIndex > 0 && credential.name !== "no credential")
                continue;
            }
            for (const query of queries) {
              for (const readView of door.reads ? readViews : [undefined]) {
                const label = `${door.method} ${door.template} (${credential.name}, ${body.name}${query === "" ? "" : ", " + query}${readView === undefined ? "" : ", read view"}${fill === "unknown" ? "" : ", " + fill + " ids"})`;
                const res = await fetch(
                  `${apiUrl}${filled(door.template, fill)}${query}`,
                  {
                    method: door.method,
                    headers: {
                      ...credential.headers,
                      ...body.headers,
                      ...(readView === undefined
                        ? {}
                        : { "X-Marfa-Read-View": readView }),
                    },
                    body: door.reads ? undefined : body.body,
                    redirect: "manual",
                  },
                );
                const text = await res.text();
                if (res.status < 400) {
                  if (!door.reads)
                    wrote.push(`${label} answered ${String(res.status)}`);
                  continue;
                }
                refusals += 1;
                if (!(res.headers.get("Content-Type") ?? "").includes("json")) {
                  continue;
                }
                let parsed: { error?: unknown } | undefined;
                try {
                  parsed = JSON.parse(text) as { error?: unknown };
                } catch {
                  outside.push(`${label}: not JSON: ${text.slice(0, 80)}`);
                  continue;
                }
                const error = parsed.error;
                if (error === null || typeof error !== "object") continue;
                const code = (error as { code?: unknown }).code;
                if (typeof code !== "string" || !table.has(code)) {
                  outside.push(
                    `${label}: ${String(res.status)} ${JSON.stringify(code)}`,
                  );
                  continue;
                }
                seen.set(code, (seen.get(code) ?? 0) + 1);
              }
            }
          }
        }
      }
    }
    expect(outside).toEqual([]);
    expect(wrote).toEqual([]);
    // The witness: the requests refused in a spread of ways, so that a
    // code outside the table had every chance to appear.
    expect(refusals).toBeGreaterThan(1000);
    expect(seen.size).toBeGreaterThanOrEqual(15);
  }, 600_000);
});

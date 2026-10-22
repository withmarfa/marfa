import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";

/**
 * What a request no door serves is answered: a path nobody serves, or a
 * method nobody serves on a path another method does. The answer is the
 * standard envelope, except for the one request a conditional-read proof
 * makes ambiguous.
 */
let ctx: TestContext;
let client: MarfaClient;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "unmatched-paths",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

const PROOF = "a".repeat(64);

interface Answer {
  status: number;
  code: string | undefined;
  header: string | null;
  body: Record<string, unknown>;
}

async function ask(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const res = await fetch(`${apiUrl}${path}`, { method, headers });
  const body = (await res.json()) as {
    error?: { code?: string };
  } & Record<string, unknown>;
  return {
    status: res.status,
    code: body.error?.code,
    header: res.headers.get("X-Error-Code"),
    body,
  };
}

const asKey = () => ({ Authorization: `Bearer ${apiKey}` });

describe("a request no door serves", () => {
  it("answers a GET to a path no door serves 404 not_found in the envelope, to a caller with a credential and to one without", async () => {
    // The witness: a door that is served answers the same caller.
    expect((await ask("GET", "/items", asKey())).status).toBe(200);

    for (const headers of [{}, asKey()]) {
      const answer = await ask("GET", "/no-such-door", headers);
      expect(answer.status).toBe(404);
      expect(answer.code).toBe("not_found");
      expect(answer.header).toBe("not_found");
      expect(answer.body).toEqual({
        error: { code: "not_found", message: "Not found" },
      });
    }
  });

  it("answers a method no door serves on a path another method serves 404 not_found, not 405", async () => {
    // The witness: the path is served to another method.
    expect((await ask("GET", "/items", asKey())).status).toBe(200);
    expect((await ask("GET", "/health")).status).toBe(200);

    for (const [method, path, headers] of [
      ["PATCH", "/items", asKey()],
      ["DELETE", "/items", asKey()],
      ["PUT", "/health", {}],
    ] as const) {
      const answer = await ask(method, path, headers);
      expect(answer.status, `${method} ${path}`).toBe(404);
      expect(answer.code, `${method} ${path}`).toBe("not_found");
    }
  });

  it("answers a PATCH to an item's metadata 404 not_found, under an Idempotency-Key it then keeps no record of, and writes nothing", async () => {
    const created = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "unmatched metadata" },
      tags: ["kept"],
    });
    expect(created.status).toBe(201);
    const id = created.data!.item.id;
    trackItem(ctx, id);
    const version = created.data!.item.version;
    // The witness: the path is served to another method.
    expect((await ask("GET", `/items/${id}/metadata`, asKey())).status).toBe(
      200,
    );

    const key = `unmatched-metadata-${ctx.runId}`;
    const send = (method: string, path: string) =>
      fetch(`${apiUrl}${path}`, {
        method,
        headers: {
          ...asKey(),
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({ tags: ["added"] }),
      });
    for (const attempt of ["first", "again"]) {
      const res = await send("PATCH", `/items/${id}/metadata`);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(res.status, attempt).toBe(404);
      expect(body.error?.code, attempt).toBe("not_found");
    }
    const after = await client.getItem(id);
    expect(after.data!.metadata.tags).toEqual(["kept"]);
    expect(after.data!.item.version).toBe(version);

    // The key was kept for nothing, so the door that adds tags takes it as
    // its own first use rather than a replay of the refusal.
    const added = await send("POST", `/items/${id}/tags`);
    expect(added.status).toBe(200);
    const answer = (await added.json()) as { metadata: { tags: string[] } };
    expect([...answer.metadata.tags].sort()).toEqual(["added", "kept"]);
  });

  it("answers a GET to a path no door serves 400 validation_error when it carries X-Marfa-Read-View, to a caller with a credential and to one without", async () => {
    // The witness: the same request without the header is the 404 above.
    expect((await ask("GET", "/no-such-door", asKey())).status).toBe(404);

    for (const headers of [{}, asKey()]) {
      const answer = await ask("GET", "/no-such-door", {
        ...headers,
        "X-Marfa-Read-View": PROOF,
      });
      expect(answer.status).toBe(400);
      expect(answer.code).toBe("validation_error");
      expect(answer.header).toBe("validation_error");
    }
  });

  it("answers a method other than GET to a path no door serves 404 not_found even when it carries X-Marfa-Read-View", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const answer = await ask(method, "/no-such-door", {
        ...asKey(),
        "X-Marfa-Read-View": PROOF,
      });
      expect(answer.status, method).toBe(404);
      expect(answer.code, method).toBe("not_found");
    }
  });
});

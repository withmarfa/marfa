import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestContext } from "../../client/types.js";
import { cleanup, createTestContext } from "../../utils/setup.js";

/**
 * What a request no door serves is answered: a path nobody serves, or a
 * method nobody serves on a path another method does. The answer is the
 * standard envelope, except for the one request a conditional-read proof
 * makes ambiguous.
 */
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, apiUrl, apiKey } = await createTestContext(
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

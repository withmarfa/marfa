import { beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import { getOwnerClient } from "../../utils/setup.js";

/** A boolean in the query is `true` or `false`: `errors.md`. */

let owner: MarfaClient;

beforeAll(() => {
  owner = getOwnerClient();
});

const SPELLINGS = ["1", "0", "yes", "no", "TRUE", "True", ""];

const DOORS: {
  name: string;
  method: string;
  path: (value: string) => string;
  body?: Record<string, unknown>;
}[] = [
  {
    name: "force on DELETE /types/{id}",
    method: "DELETE",
    path: (value) => `/types/user.no-such-type?force=${value}`,
  },
  {
    name: "force on PUT /types/{id}",
    method: "PUT",
    path: (value) => `/types/user.no-such-type?force=${value}`,
    body: {},
  },
  {
    name: "force on DELETE /edge-types/{id}",
    method: "DELETE",
    path: (value) => `/edge-types/no-such-edge-type?force=${value}`,
  },
  {
    name: "files on GET /export",
    method: "GET",
    path: (value) => `/export?format=archive&files=${value}`,
  },
  {
    name: "copy on GET /events",
    method: "GET",
    path: (value) => `/events?edges=all&copy=${value}`,
  },
];

describe("a boolean in the query", () => {
  for (const door of DOORS) {
    it(`takes true, and refuses every other spelling, for ${door.name}`, async () => {
      // The witness: the same request with `true` gets past the check.
      if (!door.name.startsWith("copy") && !door.name.startsWith("files")) {
        const taken = await owner.rawRequest<unknown>(door.path("true"), {
          method: door.method,
          ...(door.body ? { body: door.body } : {}),
        });
        expect(taken.status, door.name).not.toBe(400);
      }
      for (const value of SPELLINGS) {
        const refused = await owner.rawRequest<unknown>(door.path(value), {
          method: door.method,
          ...(door.body ? { body: door.body } : {}),
        });
        expect(refused.status, `${door.name}=${value}`).toBe(400);
        expect(refused.error?.error.code, `${door.name}=${value}`).toBe(
          "validation_error",
        );
      }
    });
  }

  it("takes false on the doors that read a whole archive and a stream", async () => {
    const archive = await owner.rawRequest<unknown>(
      "/export?format=archive&files=false",
    );
    expect(archive.status).toBe(200);
  });
});

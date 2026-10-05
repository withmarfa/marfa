import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";

/**
 * A type whose stored parent chain cannot be resolved answers `409
 * type_chain_unresolvable`, and can be corrected through `PUT /types/{id}`.
 *
 * **Arranged in the stored file, on a server of its own.** Every door that
 * writes a type refuses a cycle and a chain past the bound, so no request
 * produces one. What produces one is a registry that already held it, a file
 * written by an earlier build or by hand. The fixture registers two types
 * over HTTP, stops the server, points the root's `parent` at its child in the
 * stored row, and boots the server on that file. What is asserted is what the
 * instance then answers.
 */
let server: FreshServer | undefined;

const ROOT = "chain.root";
const CHILD = "chain.child";

beforeAll(async () => {
  server = await bootFreshServer("type-chain-unresolvable");
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

async function send(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${server!.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${server!.workingKey}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("a type whose stored parent chain is a cycle", () => {
  it(
    "answers 409 type_chain_unresolvable naming the type, and is corrected by PUT /types/{id}",
    async () => {
      const root = await send("POST", "/types", {
        id: ROOT,
        version: 1,
        fields: {},
      });
      expect(root.status).toBe(201);
      const child = await send("POST", "/types", {
        id: CHILD,
        version: 1,
        parent: ROOT,
        fields: {},
      });
      expect(child.status).toBe(201);
      // The control: the chain resolves until the file is changed.
      expect((await send("GET", `/types/${CHILD}`)).status).toBe(200);

      // The doors refuse the cycle, which is why it is written into the file.
      const refused = await send("PUT", `/types/${ROOT}`, {
        version: 1,
        parent: CHILD,
        fields: {},
      });
      expect(refused.status).toBe(400);
      expect(
        ((await refused.json()) as { error: { code: string } }).error.code,
      ).not.toBe("type_chain_unresolvable");

      await server!.restart(() => {
        const changed = withInstanceDatabase(server!.sqlitePath, (db) =>
          db
            .prepare(
              "UPDATE types SET schema = json_set(schema, '$.parent', ?) WHERE id = ?",
            )
            .run(CHILD, ROOT),
        );
        expect(Number(changed.changes)).toBe(1);
      });

      const unresolved = await send("GET", `/types/${CHILD}`);
      expect(unresolved.status).toBe(409);
      expect(unresolved.headers.get("X-Error-Code")).toBe(
        "type_chain_unresolvable",
      );
      const body = (await unresolved.json()) as {
        error: {
          code: string;
          details: { type_id: string; at: string };
        };
      };
      expect(body.error.code).toBe("type_chain_unresolvable");
      expect(body.error.details.type_id).toBe(CHILD);

      // The way back: the write door reads the stored schema without walking
      // the chain, so it answers, and the read resolves once the cycle is gone.
      const corrected = await send("PUT", `/types/${ROOT}`, {
        version: 1,
        fields: {},
      });
      expect(corrected.status).toBe(200);
      const resolved = await send("GET", `/types/${CHILD}`);
      expect(resolved.status).toBe(200);
      expect(((await resolved.json()) as { parent?: string }).parent).toBe(
        ROOT,
      );
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});

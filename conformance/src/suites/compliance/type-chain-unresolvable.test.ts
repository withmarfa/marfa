import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * A type whose stored definition does not read answers `409
 * type_chain_unresolvable`, and can be corrected through `PUT /types/{id}`.
 *
 * **Arranged by a fault.** Every door that writes a type judges what it
 * writes, so no request stores a definition the server cannot read. The
 * `unreadable:type-definition` fault makes the server read the stored
 * definition of one type as damaged, as a registry that already held it would
 * be read. What is asserted is what the instance then answers.
 */
let server: FreshServer | undefined;

const TYPE = "chain.damaged";

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

describe("a type whose stored definition does not read", () => {
  it("answers 409 type_chain_unresolvable naming the type, and is corrected by PUT /types/{id}", async () => {
    const registered = await send("POST", "/types", {
      id: TYPE,
      version: 1,
      fields: {},
    });
    expect(registered.status).toBe(201);
    // The control: the type reads until the fault is set.
    expect((await send("GET", `/types/${TYPE}`)).status).toBe(200);

    await server!.setFault(`unreadable:type-definition=${TYPE}`);

    const unresolved = await send("GET", `/types/${TYPE}`);
    expect(unresolved.status).toBe(409);
    expect(unresolved.headers.get("X-Error-Code")).toBe(
      "type_chain_unresolvable",
    );
    const body = (await unresolved.json()) as {
      error: { code: string; details: { type_id: string } };
    };
    expect(body.error.code).toBe("type_chain_unresolvable");
    expect(body.error.details.type_id).toBe(TYPE);

    // The way back: the write door accepts a corrected definition although
    // the stored one does not read.
    const corrected = await send("PUT", `/types/${TYPE}`, {
      version: 1,
      description: "Corrected.",
      fields: {},
    });
    expect(corrected.status).toBe(200);

    await server!.clearFault();
    const resolved = await send("GET", `/types/${TYPE}`);
    expect(resolved.status).toBe(200);
    expect(
      ((await resolved.json()) as { description?: string }).description,
    ).toBe("Corrected.");
  });
});

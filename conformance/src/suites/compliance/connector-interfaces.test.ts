import { expectMatchesSchema } from "../../utils/openapi.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import { HeldLock } from "../../utils/held-lock.js";

let server: FreshServer;
let key: string;
let id: string;
let keyId: string;
const source = "interface-source";
async function call(
  path: string,
  method = "GET",
  body?: unknown,
  credential = key,
): Promise<Response> {
  return fetch(`${server.apiUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credential}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeAll(async () => {
  server = await bootFreshServer("connector-interfaces");
  const minted = await call(
    "/keys",
    "POST",
    { label: "connector", source },
    server.workingKey,
  );
  expect(minted.status).toBe(201);
  ({ key, id: keyId } = (await minted.json()) as { key: string; id: string });
  const registration = await call("/connectors", "POST", {
    name: "Feed reader",
  });
  expect(registration.status).toBe(201);
  ({ id } = (await registration.json()) as { id: string });
  expect(
    (await call(`/connectors/${id}/hold`, "POST", { process: "p" })).status,
  ).toBe(200);
}, FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  await server?.stop();
});

describe("connector interfaces", () => {
  it("normalizes equivalent declarations without write authority and retains inherited refinements", async () => {
    const reader = await call(
      "/keys",
      "POST",
      {
        label: "reader",
        source: "interface-reader",
        permissions: [],
        type_permissions: {},
        metadata_permissions: {},
      },
      server.workingKey,
    );
    const { key: readKey } = (await reader.json()) as { key: string };
    const parent = {
      id: "user.interface_parent",
      fields: {
        title: { type: "string", maxLength: 100, searchable: false },
        inherited: { type: "string" },
      },
      roles: ["container"],
    };
    expect(
      (await call("/types", "POST", parent, server.workingKey)).status,
    ).toBe(201);
    const input = {
      id: "user.interface_child",
      parent: parent.id,
      fields: {
        address: { type: "string", format: "url" },
        contacts: { type: "array", items_type: "string", format: "email" },
        title: { type: "string", searchable: false, maxLength: 100 },
      },
      required: ["title"],
      version: 7,
      version_policy: { max_versions: 20 },
    };
    const normalize = async (candidate: unknown) => {
      const res = await call("/types/normalize", "POST", candidate, readKey);
      expect(res.status).toBe(200);
      const value: unknown = await res.json();
      await expectMatchesSchema("POST", "/types/normalize", 200, value);
      return value as {
        type: Record<string, unknown>;
        registered_type: unknown;
        resolved_type: { fields: Record<string, unknown>; roles: string[] };
      };
    };
    const first = await normalize(input);
    expect(first.registered_type).toBeNull();
    expect(
      (await call(`/types/${input.id}`, "GET", undefined, readKey)).status,
    ).toBe(404);
    expect(
      (await call("/types", "POST", input, server.workingKey)).status,
    ).toBe(201);
    const audit = async () => {
      const response = await call(
        `/audit?resource_id=${input.id}`,
        "GET",
        undefined,
        server.managementKey,
      );
      expect(response.status).toBe(200);
      return (await response.json()) as { data: unknown[] };
    };
    const witnessed = await audit();
    expect(witnessed.data.length).toBeGreaterThan(0);
    const repeated = await normalize(input);
    expect(repeated.type).toEqual(repeated.registered_type);
    expect(repeated.resolved_type.fields.inherited).toEqual({
      type: "string",
      required: false,
      searchable: true,
    });
    expect(repeated.resolved_type.roles).toContain("container");
    const wire = (await (
      await call(`/types/${input.id}`, "GET", undefined, readKey)
    ).json()) as { fields: Record<string, unknown> };
    expect(wire.fields.inherited).toEqual({ type: "string" });

    expect(repeated.registered_type).not.toHaveProperty("fields.inherited");
    const equivalent = {
      ...input,
      required: undefined,
      fields: {
        address: { type: "url", required: false, searchable: true },
        contacts: {
          type: "array",
          items_type: "email",
          required: false,
          searchable: true,
        },
        title: {
          type: "string",
          required: true,
          searchable: false,
          maxLength: 100,
        },
      },
    };
    expect((await normalize(equivalent)).type).toEqual(repeated.type);
    expect((await normalize(input)).registered_type).toEqual(
      repeated.registered_type,
    );
    for (const candidate of [
      { ...input, stray: true },
      { ...input, parent: "user.absent" },
      { ...input, fields: { title: { type: "number" } } },
    ])
      expect(
        (await call("/types/normalize", "POST", candidate, readKey)).status,
      ).toBe(400);
    expect(
      (
        await call(
          "/types/normalize",
          "POST",
          { ...input, compatible_with: ["user.absent_compat"] },
          readKey,
        )
      ).status,
    ).toBe(422);
    expect(await audit()).toEqual(witnessed);
  });

  it(
    "publishes source problems while keeping state private and preserves them across restart and key handover",
    async () => {
      expect(
        (
          (await (await call(`/connectors/${id}`)).json()) as {
            problems: unknown;
          }
        ).problems,
      ).toEqual({});
      const problems = JSON.parse(
        '{"__proto__":"Opaque key","feed/remote":"Unavailable"}',
      ) as Record<string, string>;
      const state = { private_cursor: "cursor" };
      expect(
        (
          await call(`/connectors/${id}/state`, "PUT", {
            process: "p",
            state,
            problems,
          })
        ).status,
      ).toBe(200);
      const repeated = await call("/connectors", "POST", { name: "Repeated" });
      expect(repeated.status).toBe(200);
      expect(
        ((await repeated.json()) as { problems: unknown }).problems,
      ).toEqual(problems);
      expect((await call(`/connectors/${id}`, "DELETE")).status).toBe(200);
      const restored = await call("/connectors", "POST", { name: "Restored" });
      const restoredRegistration = (await restored.json()) as {
        id: string;
        problems: unknown;
      };
      expect(restoredRegistration.problems).toEqual(problems);
      id = restoredRegistration.id;
      expect(
        (await call(`/connectors/${id}/hold`, "POST", { process: "p" })).status,
      ).toBe(200);
      const publicRead = await call(
        `/connectors/${id}`,
        "GET",
        undefined,
        server.managementKey,
      );
      const registration = (await publicRead.json()) as { problems: unknown };
      expect(registration.problems).toEqual(problems);
      expect(registration).not.toHaveProperty("state");
      const listed = (await (
        await call("/connectors", "GET", undefined, server.managementKey)
      ).json()) as { data: { id: string; problems: unknown }[] };
      expect(listed.data.find((row) => row.id === id)?.problems).toEqual(
        problems,
      );
      expect(
        (
          await call(
            `/connectors/${id}/state`,
            "GET",
            undefined,
            server.managementKey,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await call(`/connectors/${id}/state`, "PUT", {
            process: "wrong",
            state: {},
            problems: {},
          })
        ).status,
      ).toBe(409);
      expect(
        (await call(`/connectors/${id}/state`, "PUT", { process: "p", state }))
          .status,
      ).toBe(200);
      expect(
        (await call(`/connectors/${id}/heartbeat`, "POST", {})).status,
      ).toBe(200);
      expect(
        (
          await call(`/connectors/${id}/runs`, "POST", {
            outcome: "succeeded",
            started_at: "2026-10-03T09:30:00.000Z",
            finished_at: "2026-10-03T09:31:00.000Z",
          })
        ).status,
      ).toBe(201);
      await server.restart();
      expect(
        (
          (await (await call(`/connectors/${id}/state`)).json()) as {
            problems: unknown;
          }
        ).problems,
      ).toEqual(problems);
      expect(
        (await call(`/keys/${keyId}`, "DELETE", undefined, server.workingKey))
          .status,
      ).toBe(200);
      const minted = await call(
        "/keys",
        "POST",
        { label: "successor", source },
        server.workingKey,
      );
      const oldKey = key;
      ({ key } = (await minted.json()) as { key: string });
      const successor = await call("/connectors", "POST", {
        name: "Successor",
      });
      const row = (await successor.json()) as { id: string; problems: unknown };
      expect(row.problems).toEqual(problems);
      id = row.id;
      expect(
        (await call(`/connectors/${id}/hold`, "POST", { process: "p" })).status,
      ).toBe(200);
      expect(
        (
          await call(`/connectors/${id}/state`, "PUT", {
            process: "p",
            state: {},
            problems: { feed: "New problem" },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await call(
            `/connectors/${id}/state`,
            "PUT",
            { process: "p", state: {}, problems: {} },
            oldKey,
          )
        ).status,
      ).toBe(401);
      expect(
        (
          (await (await call(`/connectors/${id}`)).json()) as {
            problems: unknown;
          }
        ).problems,
      ).toEqual({ feed: "New problem" });
      expect((await call(`/connectors/${id}/state`, "DELETE")).status).toBe(
        200,
      );
      expect(await (await call(`/connectors/${id}/state`)).json()).toEqual({
        state: {},
        problems: {},
        updated_at: null,
      });
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it("accepts independent maximum documents and rejects problem bounds without partial writes", async () => {
    const state = { bytes: "x".repeat(512 * 1024 - 12) };
    const problems = { ["é".repeat(256 * 1024 - 4) + "x"]: "" };
    const write = (map: unknown, process = "p") =>
      call(`/connectors/${id}/state`, "PUT", { process, state, problems: map });
    expect((await write(problems)).status).toBe(200);
    const process = "\u0001".repeat(100);
    expect(
      (await call(`/connectors/${id}/hold?process=p`, "DELETE")).status,
    ).toBe(200);
    expect(
      (await call(`/connectors/${id}/hold`, "POST", { process })).status,
    ).toBe(200);
    const envelope = { process, state, problems };
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBe(1049211);
    expect(
      (await call(`/connectors/${id}/state`, "PUT", envelope)).status,
    ).toBe(200);
    expect(
      (
        await call(
          `/connectors/${id}/hold?process=${encodeURIComponent(process)}`,
          "DELETE",
        )
      ).status,
    ).toBe(200);
    expect(
      (await call(`/connectors/${id}/hold`, "POST", { process: "p" })).status,
    ).toBe(200);
    for (const map of [
      { bad: "😀".repeat(251) },
      Object.fromEntries(
        Array.from({ length: 201 }, (_, i) => [String(i), "bad"]),
      ),
      { ["é".repeat(256 * 1024)]: "" },
    ])
      expect((await write(map)).status).toBe(400);
    expect(
      (
        (await (await call(`/connectors/${id}/state`)).json()) as {
          problems: unknown;
        }
      ).problems,
    ).toEqual(problems);
    expect((await write({ unicode: "😀".repeat(250) })).status).toBe(200);
    expect(
      (
        await call(`/connectors/${id}/state`, "PUT", {
          process: "p",
          state: {},
          problems: {},
        })
      ).status,
    ).toBe(200);
    // The witness is the read above that held the problems the map named; the
    // same read after the clear holds none.
    const cleared = await call(`/connectors/${id}/state`);
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { problems: unknown }).problems).toEqual(
      {},
    );
  });
  it("refuses a write whose key is revoked or expires while the write waits for the database", async () => {
    let number = 0;
    for (const ending of ["revoked", "expired"] as const) {
      for (const door of ["state", "agreements"] as const) {
        number++;
        const label = `${ending} ${door}`;
        const mint = async (suffix: string) => {
          const minted = await call(
            "/keys",
            "POST",
            { label, source: `fence-${String(number)}${suffix}` },
            server.workingKey,
          );
          expect(minted.status, label).toBe(201);
          return (await minted.json()) as { key: string; id: string };
        };
        const owner = await mint("");
        const registered = await call(
          "/connectors",
          "POST",
          { name: label },
          owner.key,
        );
        expect(registered.status, label).toBe(201);
        const connector = ((await registered.json()) as { id: string }).id;
        expect(
          (
            await call(
              `/connectors/${connector}/hold`,
              "POST",
              { process: "p" },
              owner.key,
            )
          ).status,
          label,
        ).toBe(200);
        const item = await call(
          "/items",
          "POST",
          {
            type: "core.note",
            properties: { body: label },
          },
          server.workingKey,
        );
        expect(item.status, label).toBe(201);
        const itemId = ((await item.json()) as { item: { id: string } }).item
          .id;
        const write = (marker: string) =>
          door === "state"
            ? call(
                `/connectors/${connector}/state`,
                "PUT",
                {
                  process: "p",
                  state: { marker },
                  problems: { fence: marker },
                },
                owner.key,
              )
            : call(
                `/connectors/${connector}/agreements`,
                "POST",
                {
                  process: "p",
                  set: [
                    { item_id: itemId, waiting: false, record: { marker } },
                  ],
                },
                owner.key,
              );

        // The witness: the key's own write is taken while it stands.
        expect((await write("before")).status, label).toBe(200);

        const lock = await HeldLock.take(server.sqlitePath);
        try {
          const pending = write("in flight");
          await new Promise((resolve) => setTimeout(resolve, 150));
          await lock.commit([
            ending === "revoked"
              ? `UPDATE api_keys SET revoked_at='2026-01-01T00:00:00.000Z' WHERE id='${owner.id}'`
              : `UPDATE api_keys SET expires_at='2026-01-01T00:00:00.000Z' WHERE id='${owner.id}'`,
          ]);
          expect((await pending).status, label).toBe(401);
        } finally {
          await lock.release();
        }

        // What the source holds is what the key wrote before it ended. A
        // successor under the source reads it through its own registration.
        if (ending === "expired") {
          // An expired key still holds its source until it is revoked.
          withInstanceDatabase(server.sqlitePath, (db) => {
            db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").run(
              "2026-01-02T00:00:00.000Z",
              owner.id,
            );
          });
        }
        const successor = await mint("");
        const successorRegistration = await call(
          "/connectors",
          "POST",
          { name: `${label} successor` },
          successor.key,
        );
        expect(successorRegistration.status, label).toBe(201);
        const next = ((await successorRegistration.json()) as { id: string })
          .id;
        if (door === "state") {
          const held = await call(
            `/connectors/${next}/state`,
            "GET",
            undefined,
            successor.key,
          );
          expect(await held.json(), label).toMatchObject({
            state: { marker: "before" },
            problems: { fence: "before" },
          });
        } else {
          const held = await call(
            `/connectors/${next}/agreements/lookup`,
            "POST",
            { item_ids: [itemId] },
            successor.key,
          );
          expect(
            ((await held.json()) as { data: { record: unknown }[] }).data.map(
              (row) => row.record,
            ),
            label,
          ).toEqual([{ marker: "before" }]);
        }
      }
    }
  });
});

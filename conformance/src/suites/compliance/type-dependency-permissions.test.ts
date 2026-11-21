import { afterAll, beforeAll, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { localFetch } from "../../utils/control-request.js";

let server: FreshServer;
beforeAll(async () => {
  server = await bootFreshServer("dependency-permissions");
}, FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  await server?.stop();
});

async function send(key: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${server.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

it(
  "permits connector label and optional-field updates retaining its parent without target write permission",
  async () => {
    const target = "other.base_parent";
    const fields = { title: { type: "string" } };
    expect(
      (
        await send(server.workingKey, "POST", "/types", {
          id: target,
          fields,
        })
      ).status,
    ).toBe(201);
    for (const narrowed of [false, true]) {
      const ownerHeaders = { "Content-Type": "application/json" };
      const minted = await localFetch(
        server.controlSocket,
        `${server.apiUrl}/keys`,
        {
          method: "POST",
          headers: ownerHeaders,
          body: JSON.stringify({
            label: "Connector",
            source: `connector-parent-${String(narrowed)}`,
            permissions: [],
            metadata_permissions: { types: "write" },
            type_permissions: {
              "app.*": "write",
              ...(narrowed ? { [target]: "write" } : {}),
            },
          }),
        },
      );
      expect(minted.status, await minted.clone().text()).toBe(201);
      const { key, id: keyId } = (await minted.json()) as {
        key: string;
        id: string;
      };
      const id = `app.cook.recipe_parent_${String(narrowed)}`;
      const schema = { label: "Recipe", fields: {}, parent: target };
      expect(
        (
          await send(narrowed ? key : server.workingKey, "POST", "/types", {
            id,
            ...schema,
          })
        ).status,
      ).toBe(201);
      if (narrowed) {
        const updated = await localFetch(
          server.controlSocket,
          `${server.apiUrl}/keys/${keyId}`,
          {
            method: "PATCH",
            headers: ownerHeaders,
            body: JSON.stringify({
              type_permissions: { "app.*": "write", [target]: "read" },
            }),
          },
        );
        expect(updated.status, await updated.clone().text()).toBe(200);
      }
      const relabeled = { ...schema, label: "Updated recipe" };
      expect((await send(key, "PUT", `/types/${id}`, relabeled)).status).toBe(
        200,
      );
      const extended = {
        ...relabeled,
        fields: { ...schema.fields, extra: { type: "string" } },
      };
      expect((await send(key, "PUT", `/types/${id}`, extended)).status).toBe(
        200,
      );
      expect((await send(key, "GET", `/types/${id}`)).body).toMatchObject(
        extended,
      );
      const refused = await send(key, "POST", "/types", {
        id: `${id}_new`,
        ...schema,
      });
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        error: {
          code: "type_not_permitted",
          details: { grant: { name: target, level: "write" } },
        },
      });
    }
  },
  FRESH_SERVER_TIMEOUT_MS,
);

it(
  "requires target write permission for new dependencies but permits retained dependencies",
  async () => {
    let sequence = 0;
    for (const grant of [undefined, "read", "none"] as const) {
      const minted = await localFetch(
        server.controlSocket,
        `${server.apiUrl}/keys`,
        {
          headers: { "Content-Type": "application/json" },
          method: "POST",
          body: JSON.stringify({
            label: "Dependency author",
            source: `dependency-${grant ?? "absent"}`,
            permissions: ["schema.write"],
            metadata_permissions: { types: "write" },
            type_permissions: {
              "foreign.*": "write",
              ...(grant ? { "user.*": grant } : {}),
            },
          }),
        },
      );
      expect(minted.status, await minted.clone().text()).toBe(201);
      const { key } = (await minted.json()) as { key: string };
      const platform = {
        id: `foreign.platform_${grant ?? "absent"}`,
        parent: "core.note",
        fields: {},
      };
      expect((await send(key, "POST", "/types", platform)).status).toBe(201);
      expect(
        (await send(key, "PUT", `/types/${platform.id}`, platform)).status,
      ).toBe(200);
      for (const kind of ["parent", "display", "link", "merge"]) {
        const suffix = sequence++ === 0 ? "" : `_${sequence}`;
        const target = `user.target${suffix}`;
        const reader = `foreign.reader${suffix}`;
        const fields = { title: { type: "string" } };
        const schema = {
          fields: {},
          parent: target,
          ...(kind === "display"
            ? { display_hints: { title_field: "title" } }
            : {}),
          ...(kind === "link" ? { link_field: "title" } : {}),
          ...(kind === "merge"
            ? { merge_policy: { fields: { title: "last_writer_wins" } } }
            : {}),
        };
        expect(
          (
            await send(server.workingKey, "POST", "/types", {
              id: target,
              fields,
            })
          ).status,
        ).toBe(201);
        const parent = await send(key, "POST", "/types", {
          id: reader,
          fields: {},
          parent: target,
        });
        expect(parent.status).toBe(403);
        expect(parent.body).toMatchObject({
          error: {
            code: "type_not_permitted",
            details: { grant: { name: target, level: "write" } },
          },
        });
        const register = await send(key, "POST", "/types", {
          id: reader,
          ...schema,
        });
        expect(register, `${grant ?? "absent"}: ${kind} registration`).toEqual(
          parent,
        );
        expect(
          (await send(server.workingKey, "GET", `/types/${reader}`)).status,
        ).toBe(404);
        expect(
          (await send(key, "POST", "/types", { id: reader, fields })).status,
        ).toBe(201);
        const before = await send(server.workingKey, "GET", `/types/${reader}`);
        expect(await send(key, "PUT", `/types/${reader}`, schema)).toEqual(
          parent,
        );
        expect(
          await send(server.workingKey, "GET", `/types/${reader}`),
        ).toEqual(before);
        expect(
          (
            await send(server.workingKey, "PUT", `/types/${target}`, {
              fields: { title: { type: "integer" } },
            })
          ).status,
        ).toBe(200);
        expect(
          (await send(server.workingKey, "DELETE", `/types/${target}`)).status,
        ).toBe(200);
        expect(
          (
            await send(server.workingKey, "POST", "/types", {
              id: target,
              fields,
            })
          ).status,
        ).toBe(201);
        expect(
          (
            await send(server.workingKey, "PUT", `/types/${reader}`, {
              fields: {},
              parent: target,
            })
          ).status,
        ).toBe(200);
        expect(
          (await send(key, "PUT", `/types/${reader}`, schema)).status,
        ).toBe(200);
        expect(
          (await send(server.workingKey, "PUT", `/types/${reader}`, schema))
            .status,
        ).toBe(200);
        expect(
          (
            await send(key, "PUT", `/types/${reader}`, {
              ...schema,
              label: "Kept dependency",
            })
          ).status,
        ).toBe(200);
        expect(
          (await send(server.workingKey, "GET", `/types/${reader}`)).body,
        ).toMatchObject({ label: "Kept dependency" });
        expect(
          (await send(key, "PUT", `/types/${reader}`, { fields })).status,
        ).toBe(200);
        expect(
          (
            await send(server.workingKey, "PUT", `/types/${target}`, {
              fields: { title: { type: "integer" } },
            })
          ).status,
        ).toBe(200);
        expect(
          (await send(server.workingKey, "DELETE", `/types/${target}`)).status,
        ).toBe(200);
        // The same registration succeeds when the caller can write its target.
        expect(
          (
            await send(server.workingKey, "POST", "/types", {
              id: target,
              fields,
            })
          ).status,
        ).toBe(201);
        expect((await send(key, "DELETE", `/types/${reader}`)).status).toBe(
          200,
        );
        expect(
          (
            await send(server.workingKey, "POST", "/types", {
              id: reader,
              ...schema,
            })
          ).status,
        ).toBe(201);
      }
    }
    await server.restart();
    const reader = await send(
      server.workingKey,
      "GET",
      "/types/foreign.reader",
    );
    expect(reader.status).toBe(200);
    expect(reader.body).toMatchObject({ parent: "user.target" });
    expect(
      (await send(server.workingKey, "DELETE", "/types/user.target")).status,
    ).toBe(409);
  },
  FRESH_SERVER_TIMEOUT_MS,
);

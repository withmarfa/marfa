import { afterAll, beforeAll, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

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
  "requires the parent's write permission for new and kept compatibility and inherited-field dependencies",
  async () => {
    let sequence = 0;
    for (const grant of [undefined, "read", "none"] as const) {
      const minted = await fetch(`${server.apiUrl}/keys`, {
        headers: {
          Cookie: server.ownerCookie,
          Origin: server.apiUrl,
          "Content-Type": "application/json",
        },
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
      });
      expect(minted.status, await minted.clone().text()).toBe(201);
      const { key } = (await minted.json()) as { key: string };
      const platform = {
        id: `foreign.platform_${grant ?? "absent"}`,
        parent: "core.note",
        compatible_with: ["core.note"],
        fields: {},
      };
      expect((await send(key, "POST", "/types", platform)).status).toBe(201);
      expect(
        (await send(key, "PUT", `/types/${platform.id}`, platform)).status,
      ).toBe(200);
      for (const kind of [
        "compatibility",
        "parent",
        "display",
        "link",
        "merge",
      ]) {
        const suffix = sequence++ === 0 ? "" : `_${sequence}`;
        const target = `user.target${suffix}`;
        const reader = `foreign.reader${suffix}`;
        const fields = { title: { type: "string" } };
        const dependency =
          kind === "compatibility"
            ? { compatible_with: [target] }
            : {
                parent: target,
                ...(kind === "display"
                  ? { display_hints: { title_field: "title" } }
                  : {}),
                ...(kind === "link" ? { link_field: "title" } : {}),
                ...(kind === "merge"
                  ? { merge_policy: { fields: { title: "last_writer_wins" } } }
                  : {}),
              };
        const schema = {
          fields: kind === "compatibility" ? fields : {},
          ...dependency,
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
        if (kind !== "compatibility") {
          expect(
            (
              await send(server.workingKey, "PUT", `/types/${reader}`, {
                fields: {},
                parent: target,
              })
            ).status,
          ).toBe(200);
          expect(await send(key, "PUT", `/types/${reader}`, schema)).toEqual(
            parent,
          );
        }
        expect(
          (await send(server.workingKey, "PUT", `/types/${reader}`, schema))
            .status,
        ).toBe(200);
        const held = await send(server.workingKey, "GET", `/types/${reader}`);
        expect(
          await send(key, "PUT", `/types/${reader}`, {
            ...schema,
            label: "Kept dependency",
          }),
        ).toEqual(parent);
        expect(
          await send(server.workingKey, "GET", `/types/${reader}`),
        ).toEqual(held);
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
    expect(reader.body).toMatchObject({ compatible_with: ["user.target"] });
    expect(
      (await send(server.workingKey, "DELETE", "/types/user.target")).status,
    ).toBe(422);
  },
  FRESH_SERVER_TIMEOUT_MS,
);

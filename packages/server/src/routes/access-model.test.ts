import { describe, it, expect } from "vitest";
import { buildAccess, resolveSelection } from "./access-model.js";
import { parseScope } from "@withmarfa/shared";
import type { ParsedScope } from "@withmarfa/shared";

const scope = (literal: string): ParsedScope => {
  const parsed = parseScope(literal);
  if (!parsed) throw new Error(`unparseable: ${literal}`);
  return parsed;
};

describe("resolveSelection", () => {
  const REQUESTED = [
    "openid",
    "offline_access",
    "core.note:read",
    "core.note:write",
    "core.task:read",
    "keys.mint",
  ];

  it("grants exactly what was chosen", () => {
    expect(resolveSelection(REQUESTED, ["core.task:read"])).toEqual({
      ok: true,
      scopes: ["core.task:read"],
      chosen: true,
    });
  });

  it("brings the read a chosen write includes, when the request named it", () => {
    const result = resolveSelection(REQUESTED, ["core.note:write"]);
    expect(result).toMatchObject({ ok: true, chosen: true });
    expect(result.ok && result.scopes.sort()).toEqual([
      "core.note:read",
      "core.note:write",
    ]);
  });

  it("does not add a read the request never named", () => {
    const result = resolveSelection(["core.note:write"], ["core.note:write"]);
    expect(result.ok && result.scopes).toEqual(["core.note:write"]);
  });

  it("refuses a literal the request did not name, and grants nothing from the rest", () => {
    expect(
      resolveSelection(REQUESTED, ["core.task:read", "core.task:write"]),
    ).toEqual({ ok: false });
    expect(resolveSelection(REQUESTED, ["webhooks.manage"])).toEqual({
      ok: false,
    });
    expect(resolveSelection(REQUESTED, ["core.*:read"])).toEqual({ ok: false });
  });

  it("reads an empty value as no access", () => {
    expect(resolveSelection(REQUESTED, ["", "core.task:read", ""])).toEqual({
      ok: true,
      scopes: ["core.task:read"],
      chosen: true,
    });
  });

  it("answers a repeated value once", () => {
    const result = resolveSelection(REQUESTED, [
      "core.task:read",
      "core.task:read",
    ]);
    expect(result.ok && result.scopes).toEqual(["core.task:read"]);
  });

  it("counts nothing but mechanisms as nothing chosen", () => {
    expect(resolveSelection(REQUESTED, ["openid", "offline_access"])).toEqual({
      ok: true,
      scopes: ["openid", "offline_access"],
      chosen: false,
    });
    expect(resolveSelection(REQUESTED, [])).toEqual({
      ok: true,
      scopes: [],
      chosen: false,
    });
  });

  it("lets a request that offers no choice be approved", () => {
    const identity = ["openid", "offline_access"];
    expect(resolveSelection(identity, identity)).toMatchObject({
      ok: true,
      chosen: true,
    });
    // Posting nothing at all is still nothing.
    expect(resolveSelection(identity, [])).toMatchObject({
      ok: true,
      chosen: false,
    });
  });

  it("counts a power on its own as something chosen", () => {
    expect(resolveSelection(REQUESTED, ["keys.mint"])).toMatchObject({
      ok: true,
      chosen: true,
    });
  });
});

describe("buildAccess", () => {
  const bundles = [] as const;

  it("holds a request to the levels it names: a type asked only to write offers write", () => {
    const model = buildAccess({
      scopes: [scope("core.note:write")],
      held: undefined,
      bundles,
    });
    expect(model.data[0]?.options.map((o) => o.value)).toEqual([
      "",
      "core.note:write",
    ]);
  });

  it("offers one row for a type however the request orders its levels", () => {
    const model = buildAccess({
      scopes: [
        scope("core.note:write"),
        scope("core.task:read"),
        scope("core.note:read"),
      ],
      held: undefined,
      bundles,
    });
    expect(model.data.map((r) => r.title)).toEqual(["Notes", "Tasks"]);
  });

  it("forces the level up when only a level above what is held is offered", () => {
    const model = buildAccess({
      scopes: [scope("core.note:write")],
      held: ["core.note:read"],
      bundles,
    });
    expect(model.data[0]?.options.map((o) => o.value)).toEqual([
      "core.note:write",
    ]);
    expect(model.data[0]?.selected).toBe("core.note:write");
  });

  it("lists everything the app holds, including what this request does not ask for", () => {
    const model = buildAccess({
      scopes: [scope("core.task:read")],
      held: ["core.note:write", "keys.mint", "openid"],
      bundles,
    });
    expect(model.held).toEqual([
      { title: "Notes", value: "Read and edit" },
      { title: "Make keys", value: "On" },
    ]);
  });

  it("groups powers in a fixed order whatever order the app asked in", () => {
    const model = buildAccess({
      scopes: [
        scope("items.purge"),
        scope("keys.manage"),
        scope("webhooks.manage"),
        scope("keys.mint"),
      ],
      held: undefined,
      bundles,
    });
    expect(
      model.powers.map((s) => [s.title, s.rows.map((r) => r.literal)]),
    ).toEqual([
      ["Keys and apps", ["keys.mint", "keys.manage"]],
      ["Connections and records", ["webhooks.manage", "items.purge"]],
    ]);
  });
});

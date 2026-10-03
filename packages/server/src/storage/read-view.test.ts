import { describe, expect, it } from "vitest";
import type { ApiKey } from "@withmarfa/shared";
import { canonicalReadProjection } from "./read-view.js";
const bound = { kind: "api_key" as const, id: "key", hash: "hash" };
const key = {
  id: "key",
  label: "own.namespace",
  source: "origin",
  default_tier: "library",
  is_operator: false,
  type_permissions: {},
  created_at: "2026-01-01T00:00:00Z",
  last_used_at: null,
} satisfies ApiKey;
const projection = (patch: Partial<ApiKey>) =>
  canonicalReadProjection({ ...key, ...patch }, bound, {});
describe("canonical effective read projection", () => {
  it("bounds descendant wildcard normalization and retains its denial", () => {
    expect(
      projection({
        type_permissions: { "core.*": "read", "core.note.*": "none" },
      }),
    ).not.toEqual(projection({ type_permissions: { "core.*": "read" } }));
    expect(
      projection({
        type_permissions: { "core.*": "read", "core.note.*": "read" },
      }),
    ).toEqual(projection({ type_permissions: { "core.*": "read" } }));
  });
  it("preserves an exact root denial beside a parent-inclusive wildcard", () => {
    expect(
      projection({
        type_permissions: { "core.note": "none", "core.note.*": "read" },
      }),
    ).not.toEqual(projection({ type_permissions: { "core.note.*": "read" } }));
    expect(
      projection({
        type_permissions: { "core.note": "read", "core.note.*": "read" },
      }),
    ).toEqual(projection({ type_permissions: { "core.note.*": "read" } }));
  });
  it("distinguishes wildcard extension access from only the implicit namespace", () => {
    expect(projection({ extension_permissions: {} })).not.toEqual(
      projection({ extension_permissions: { "*": "read" } }),
    );
    expect(
      projection({ extension_permissions: { "own.namespace": "read" } }),
    ).toEqual(projection({ extension_permissions: {} }));
    expect(
      projection({
        extension_permissions: {
          "own.namespace": "none",
        } as unknown as ApiKey["extension_permissions"],
      }),
    ).not.toEqual(projection({ extension_permissions: {} }));
  });
  it("collapses unchanged read reach across write reductions and irrelevant powers", () => {
    expect(
      projection({
        type_permissions: { "*": "write", "core.note": "write" },
        edge_permissions: { "*": "write" },
        metadata_permissions: { types: "write" },
        sources: ["claimed"],
        is_operator: true,
      }),
    ).toEqual(
      projection({
        type_permissions: { "*": "read" },
        edge_permissions: { "*": "read" },
        metadata_permissions: { types: "read" },
      }),
    );
  });
});

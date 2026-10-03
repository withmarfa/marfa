import { afterEach, describe, expect, it } from "vitest";
import {
  createRegistryFrame,
  discardRegistryFrame,
  mergeRegistryFrame,
  prepareRegistryPublication,
  publishRegistryView,
  registryView,
  setRegistryFrameAccessor,
  removePlatformRegistryType,
  type RegistryFrame,
} from "./registry-view.js";
import {
  getTypeSchema,
  registerTypeSchema,
  unregisterTypeSchema,
  validateProperties,
  TYPE_REGISTRY,
  SYSTEM_TYPE_IDS,
  seedPlatformTypes,
  shippedPlatformTypes,
  listTypes,
  directChildrenOf,
  maxDescendantDepth,
  getResolvedFields,
  getSearchableStringFields,
  declaredDescendantsOutsideNamespace,
  typeHasRole,
} from "./type-registry.js";
import {
  edgeNameHolder,
  edgeNameCollisions,
  getEdgeTypeSchema,
  listEdgeTypes,
  registerEdgeTypeSchema,
  unregisterEdgeTypeSchema,
  satisfiesEdgeConstraint,
} from "./edge-registry.js";

const original = registryView();
let selected: RegistryFrame | undefined;
setRegistryFrameAccessor(() => selected);
afterEach(() => {
  selected = undefined;
  publishRegistryView(original);
});
function commit(frame: RegistryFrame) {
  const prepared = prepareRegistryPublication(frame);
  if (prepared) publishRegistryView(prepared);
  discardRegistryFrame(frame);
  selected = undefined;
}
const parent = {
  id: "example.parent",
  version: 1,
  roles: ["container" as const],
  fields: { inherited: { type: "string" as const, required: true } },
};
const child = { id: "other.child", parent: parent.id, version: 1, fields: {} };
const edge = {
  id: "example.related",
  cardinality: "many-to-many" as const,
  cascade_on_delete: "orphan" as const,
  source_type_constraints: [parent.id],
  target_type_constraints: ["role:container"],
  reverse_name: "example.reverse",
  property_schema: {},
  written_at: "source" as const,
};
const props = { inherited: "value" };

describe("selected registry views", () => {
  it("all semantic helpers see a staged vocabulary and outside callers keep the committed view", () => {
    selected = createRegistryFrame();
    const frame = selected;
    registerTypeSchema(parent);
    registerTypeSchema(child);
    registerEdgeTypeSchema(edge);
    expect(listTypes().some((schema) => schema.id === child.id)).toBe(true);
    expect(getResolvedFields(child.id)).toHaveProperty(
      "inherited.required",
      true,
    );
    expect(getSearchableStringFields(child.id)).toContain("inherited");
    expect(directChildrenOf(parent.id)).toEqual([child.id]);
    expect(maxDescendantDepth(parent.id)).toBe(1);
    expect(declaredDescendantsOutsideNamespace(parent.id)).toEqual([child.id]);
    expect(typeHasRole(child.id, "container")).toBe(true);
    expect(satisfiesEdgeConstraint(child.id, [parent.id])).toBe(true);
    expect(satisfiesEdgeConstraint(child.id, ["role:container"])).toBe(true);
    expect(listEdgeTypes()).toContainEqual(edge);
    expect(edgeNameHolder(edge.reverse_name)).toBe(edge.id);
    expect(edgeNameCollisions()).toEqual({});
    expect(validateProperties(child.id, props).success).toBe(true);
    expect(validateProperties(child.id, props, { strict: true }).success).toBe(
      true,
    );
    selected = undefined;
    expect(getTypeSchema(child.id)).toBeUndefined();
    expect(getEdgeTypeSchema(edge.id)).toBeUndefined();
    expect(edgeNameHolder(edge.reverse_name)).toBeUndefined();
    expect(original.permissive.has(child.id)).toBe(false);
    expect(original.strict.has(child.id)).toBe(false);
    commit(frame);
    expect(getTypeSchema(child.id)).toEqual(child);
    expect(getEdgeTypeSchema(edge.id)).toEqual(edge);
    expect(validateProperties(child.id, props, { strict: true }).success).toBe(
      true,
    );
  });

  it("successful child scopes merge while failed child scopes discard their schemas and caches", () => {
    selected = createRegistryFrame();
    const root = selected;
    registerTypeSchema(parent);
    selected = createRegistryFrame(root);
    const failed = selected;
    registerTypeSchema(child);
    expect(validateProperties(child.id, props, { strict: true }).success).toBe(
      true,
    );
    discardRegistryFrame(failed);
    selected = root;
    expect(getTypeSchema(child.id)).toBeUndefined();
    selected = createRegistryFrame(root);
    const successful = selected;
    registerTypeSchema(child);
    registerEdgeTypeSchema(edge);
    mergeRegistryFrame(successful);
    selected = root;
    expect(getTypeSchema(child.id)).toEqual(child);
    expect(edgeNameHolder(edge.reverse_name)).toBe(edge.id);
    discardRegistryFrame(root);
    selected = undefined;
    expect(getTypeSchema(parent.id)).toBeUndefined();
    expect(getEdgeTypeSchema(edge.id)).toBeUndefined();
  });

  it("reparent and removal keep both compiled modes local until root publication", () => {
    selected = createRegistryFrame();
    registerTypeSchema(parent);
    registerTypeSchema(child);
    commit(selected);
    expect(validateProperties(child.id, props).success).toBe(true);
    expect(validateProperties(child.id, props, { strict: true }).success).toBe(
      true,
    );
    const committedBefore = registryView();
    selected = createRegistryFrame();
    const frame = selected;
    registerTypeSchema({
      id: "second.parent",
      version: 1,
      fields: { other: { type: "string", required: true } },
    });
    registerTypeSchema({ ...child, parent: "second.parent" });
    expect(validateProperties(child.id, props).success).toBe(false);
    expect(
      validateProperties(child.id, { other: "new" }, { strict: true }).success,
    ).toBe(true);
    unregisterTypeSchema("second.parent");
    expect(getResolvedFields(child.id)).not.toHaveProperty("other");
    discardRegistryFrame(frame);
    selected = undefined;
    expect(registryView()).toBe(committedBefore);
    expect(validateProperties(child.id, props).success).toBe(true);
    expect(validateProperties(child.id, props, { strict: true }).success).toBe(
      true,
    );
    selected = createRegistryFrame();
    unregisterTypeSchema(child.id);
    commit(selected);
    expect(getTypeSchema(child.id)).toBeUndefined();
    expect(validateProperties(child.id, props).success).toBe(false);
  });

  it("captured platform handles track committed facets and system membership without exposing mutators", () => {
    const map = TYPE_REGISTRY,
      set = SYSTEM_TYPE_IDS;
    selected = createRegistryFrame();
    const frame = selected;
    seedPlatformTypes([
      ...shippedPlatformTypes(),
      {
        schema: { id: "system.retired", version: 1, fields: {} },
        family: "system",
      },
    ]);
    expect(map.has("system.retired")).toBe(true);
    expect(set.has("system.retired")).toBe(true);
    selected = undefined;
    expect(map.has("system.retired")).toBe(false);
    expect(set.has("system.retired")).toBe(false);
    commit(frame);
    expect(map.has("system.retired")).toBe(true);
    expect(set.has("system.retired")).toBe(true);
    expect((map as unknown as { set?: unknown }).set).toBeUndefined();
    map.forEach((_value, _key, captured) => {
      expect(captured).toBe(map);
    });
    selected = createRegistryFrame();
    removePlatformRegistryType("system.retired");
    commit(selected);
    expect(map.has("system.retired")).toBe(false);
    expect(set.has("system.retired")).toBe(false);
  });

  it("an escaped closed scope cannot mutate or read the committed registry", () => {
    selected = createRegistryFrame();
    const frame = selected;
    registerTypeSchema(parent);
    commit(frame);
    selected = frame;
    expect(() => {
      registerTypeSchema(child);
    }).toThrow("context is closed");
    expect(() => {
      unregisterTypeSchema(parent.id);
    }).toThrow("context is closed");
    expect(() => getTypeSchema(parent.id)).toThrow("context is closed");
    selected = undefined;
    expect(getTypeSchema(parent.id)).toEqual(parent);
    expect(getTypeSchema(child.id)).toBeUndefined();
  });

  it("unscoped clients retain immediate item and edge registration behavior", () => {
    const base = registryView();
    publishRegistryView({
      ...base,
      custom: new Map(base.custom),
      edges: new Map(base.edges),
      permissive: new Map(),
      strict: new Map(),
    });
    registerTypeSchema(parent);
    registerEdgeTypeSchema(edge);
    expect(getTypeSchema(parent.id)).toEqual(parent);
    expect(getEdgeTypeSchema(edge.id)).toEqual(edge);
    unregisterTypeSchema(parent.id);
    unregisterEdgeTypeSchema(edge.id);
    expect(getTypeSchema(parent.id)).toBeUndefined();
    expect(getEdgeTypeSchema(edge.id)).toBeUndefined();
  });
});

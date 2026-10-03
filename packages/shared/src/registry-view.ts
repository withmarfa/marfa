import type { EdgeTypeSchema, TypeSchema } from "@withmarfa/types";
import type { ZodType } from "zod";

const REMOVED = Symbol("removed");
class Overlay<K, V> implements ReadonlyMap<K, V> {
  readonly changes = new Map<K, V | typeof REMOVED>();
  constructor(private readonly base: ReadonlyMap<K, V>) {}
  get(key: K): V | undefined {
    const value = this.changes.get(key);
    return value === REMOVED
      ? undefined
      : this.changes.has(key)
        ? value
        : this.base.get(key);
  }
  has(key: K): boolean {
    return this.changes.has(key)
      ? this.changes.get(key) !== REMOVED
      : this.base.has(key);
  }
  *entries(): MapIterator<[K, V]> {
    for (const entry of this.base) if (!this.changes.has(entry[0])) yield entry;
    for (const [key, value] of this.changes)
      if (value !== REMOVED) yield [key, value];
  }
  *keys(): MapIterator<K> {
    for (const [key] of this) yield key;
  }
  *values(): MapIterator<V> {
    for (const [, value] of this) yield value;
  }
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
  get size(): number {
    return [...this.keys()].length;
  }
  forEach(
    fn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this) fn.call(thisArg, value, key, this);
  }
}

export interface RegistryView {
  platform: ReadonlyMap<string, TypeSchema>;
  custom: ReadonlyMap<string, TypeSchema>;
  edges: ReadonlyMap<string, EdgeTypeSchema>;
  system: ReadonlyMap<string, true>;
  permissive: Map<string, ZodType>;
  strict: Map<string, ZodType>;
}
export interface RegistrySnapshot {
  platform: readonly { schema: TypeSchema; family: "core" | "system" }[];
  custom: readonly TypeSchema[];
  edges: readonly EdgeTypeSchema[];
}
export interface RegistryFrame {
  readonly parent?: RegistryFrame;
  readonly view: RegistryView;
  active: boolean;
  dirty: boolean;
  itemDirty: boolean;
}
let committed: RegistryView = {
  platform: new Map(),
  custom: new Map(),
  edges: new Map(),
  system: new Map(),
  permissive: new Map(),
  strict: new Map(),
};
let selected: () => RegistryFrame | undefined = () => undefined;
export function setRegistryFrameAccessor(
  accessor: () => RegistryFrame | undefined,
): void {
  selected = accessor;
}
export function registryView(): RegistryView {
  const frame = selected();
  if (frame && !frame.active)
    throw new Error("Registry transaction context is closed");
  return frame?.view ?? committed;
}
export function createRegistryFrame(parent?: RegistryFrame): RegistryFrame {
  if (parent && !parent.active)
    throw new Error("Registry transaction context is closed");
  const base = parent?.view ?? committed;
  return {
    parent,
    active: true,
    dirty: false,
    itemDirty: false,
    view: {
      platform: new Overlay(base.platform),
      custom: new Overlay(base.custom),
      edges: new Overlay(base.edges),
      system: new Overlay(base.system),
      permissive: new Map(),
      strict: new Map(),
    },
  };
}
function change<K, V>(
  map: ReadonlyMap<K, V>,
  key: K,
  value: V | typeof REMOVED,
): void {
  if (map instanceof Overlay) map.changes.set(key, value);
  else if (value === REMOVED) (map as Map<K, V>).delete(key);
  else (map as Map<K, V>).set(key, value);
}
function mutate(item: boolean, fn: (view: RegistryView) => void): void {
  const view = registryView();
  fn(view);
  const frame = selected();
  if (frame) {
    frame.dirty = true;
    frame.itemDirty ||= item;
  }
  if (item) {
    view.permissive.clear();
    view.strict.clear();
  }
}
export function stageRegistryType(schema: TypeSchema): void {
  mutate(true, (view) => {
    change(view.custom, schema.id, schema);
  });
}
export function removeRegistryType(id: string): void {
  mutate(true, (view) => {
    change(view.custom, id, REMOVED);
  });
}
export function stagePlatformRegistryType(
  schema: TypeSchema,
  family: "core" | "system",
): void {
  mutate(true, (view) => {
    change(view.platform, schema.id, schema);
    change(view.system, schema.id, family === "system" ? true : REMOVED);
  });
}
export function removePlatformRegistryType(id: string): void {
  mutate(true, (view) => {
    change(view.platform, id, REMOVED);
    change(view.system, id, REMOVED);
  });
}
export function stageRegistryEdge(schema: EdgeTypeSchema): void {
  mutate(false, (view) => {
    change(view.edges, schema.id, schema);
  });
}
export function removeRegistryEdge(id: string): void {
  mutate(false, (view) => {
    change(view.edges, id, REMOVED);
  });
}
export function seedRegistryPlatform(
  platform: RegistrySnapshot["platform"],
): void {
  mutate(true, (view) => {
    for (const id of view.platform.keys()) change(view.platform, id, REMOVED);
    for (const id of view.system.keys()) change(view.system, id, REMOVED);
    for (const { schema, family } of platform) {
      change(view.platform, schema.id, schema);
      if (family === "system") change(view.system, schema.id, true);
    }
  });
}
export function discardRegistryFrame(frame: RegistryFrame): void {
  frame.active = false;
  frame.view.permissive.clear();
  frame.view.strict.clear();
}
export function mergeRegistryFrame(frame: RegistryFrame): void {
  if (!frame.active || !frame.parent?.active)
    throw new Error("Registry transaction context is closed");
  const parent = frame.parent;
  for (const facet of ["platform", "custom", "edges", "system"] as const) {
    const overlay = frame.view[facet] as Overlay<
      string,
      TypeSchema | EdgeTypeSchema | true
    >;
    const target = parent.view[facet] as ReadonlyMap<
      string,
      TypeSchema | EdgeTypeSchema | true
    >;
    for (const [id, value] of overlay.changes) change(target, id, value);
  }
  parent.dirty ||= frame.dirty;
  parent.itemDirty ||= frame.itemDirty;
  if (frame.itemDirty) {
    parent.view.permissive.clear();
    parent.view.strict.clear();
  }
  discardRegistryFrame(frame);
}
export function prepareRegistryPublication(
  frame: RegistryFrame,
): RegistryView | undefined {
  if (!frame.active || frame.parent)
    throw new Error("Invalid root registry transaction");
  if (!frame.dirty) return undefined;
  return {
    platform: new Map(frame.view.platform),
    custom: new Map(frame.view.custom),
    edges: new Map(frame.view.edges),
    system: new Map(frame.view.system),
    permissive: frame.itemDirty
      ? new Map<string, ZodType>()
      : committed.permissive,
    strict: frame.itemDirty ? new Map<string, ZodType>() : committed.strict,
  };
}
export function publishRegistryView(view: RegistryView): void {
  committed = view;
}
export function registrySnapshotView(snapshot: RegistrySnapshot): RegistryView {
  return {
    platform: new Map(
      snapshot.platform.map((row) => [row.schema.id, row.schema]),
    ),
    custom: new Map(snapshot.custom.map((schema) => [schema.id, schema])),
    edges: new Map(snapshot.edges.map((schema) => [schema.id, schema])),
    system: new Map(
      snapshot.platform
        .filter((row) => row.family === "system")
        .map((row) => [row.schema.id, true]),
    ),
    permissive: new Map(),
    strict: new Map(),
  };
}
export function registryMapFacet<
  K extends "platform" | "custom" | "edges" | "system",
>(facet: K): RegistryView[K] {
  const facade = new Proxy(new Map(), {
    get(_target, prop) {
      if (prop === "forEach")
        return (
          fn: (value: unknown, key: string, map: unknown) => void,
          thisArg?: unknown,
        ) => {
          for (const [key, value] of registryView()[facet])
            fn.call(thisArg, value, key, facade);
        };
      if (
        ![
          "size",
          "get",
          "has",
          "entries",
          "keys",
          "values",
          Symbol.iterator,
          Symbol.toStringTag,
        ].includes(prop)
      )
        return undefined;
      const map = registryView()[facet];
      const value: unknown = Reflect.get(map, prop, map);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(map)
        : value;
    },
  });
  return facade as RegistryView[K];
}
export const registrySystemIds: ReadonlySet<string> = {
  has: (id) => registryView().system.has(id),
  get size() {
    return registryView().system.size;
  },
  values: () => registryView().system.keys(),
  keys: () => registryView().system.keys(),
  *entries(): SetIterator<[string, string]> {
    for (const id of registryView().system.keys()) yield [id, id];
  },
  [Symbol.iterator]: () => registryView().system.keys(),
  forEach(fn, thisArg) {
    for (const id of registryView().system.keys())
      fn.call(thisArg, id, id, this);
  },
};

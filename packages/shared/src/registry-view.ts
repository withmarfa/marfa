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
export interface RegistryReadScope {
  readonly mode: "read";
  readonly view: RegistryView;
  active: boolean;
  assertActive(): void;
}
export interface RegistryFrame {
  readonly mode: "write";
  sealed: boolean;
  reachDirty: boolean;
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
let selected: () => RegistryFrame | RegistryReadScope | undefined = () =>
  undefined;
let assertAvailable: () => void = () => undefined;
export function setRegistryFrameAccessor(
  accessor: () => RegistryFrame | RegistryReadScope | undefined,
  available: () => void = () => undefined,
): void {
  selected = accessor;
  assertAvailable = available;
}
export function registryView(): RegistryView {
  const frame = selected();
  if (frame?.mode === "read") frame.assertActive();
  assertAvailable();
  if (frame && (!frame.active || (frame.mode === "write" && frame.sealed)))
    throw new Error("Registry transaction context is closed");
  return frame?.view ?? committed;
}
export function createRegistryFrame(parent?: RegistryFrame): RegistryFrame {
  refuseReadMutation();
  if (parent && (!parent.active || parent.sealed))
    throw new Error("Registry transaction context is closed");
  const base = parent?.view ?? committed;
  return {
    parent,
    mode: "write",
    sealed: false,
    reachDirty: false,
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
function refuseReadMutation(): void {
  const scope = selected();
  if (scope?.mode === "read") {
    scope.assertActive();
    throw new Error("A read snapshot cannot mutate the registry");
  }
  if (scope && (!scope.active || scope.sealed))
    throw new Error("Registry transaction context is closed");
}
export function markStructuralReadChange(): void {
  refuseReadMutation();
  const frame = selected();
  if (frame?.mode !== "write")
    throw new Error("Structural read changes require a writer transaction");
  frame.reachDirty = true;
}
export function immutableRegistrySchema<T>(value: T): T {
  const detached = structuredClone(value);
  const freeze = (v: unknown): void => {
    if (v && typeof v === "object") {
      for (const child of Object.values(v)) freeze(child);
      Object.freeze(v);
    }
  };
  freeze(detached);
  return detached;
}
function mutate(item: boolean, fn: (view: RegistryView) => void): void {
  refuseReadMutation();
  const frame = selected();
  if (!frame)
    committed = {
      ...committed,
      platform: new Map(committed.platform),
      custom: new Map(committed.custom),
      edges: new Map(committed.edges),
      system: new Map(committed.system),
      permissive: new Map(),
      strict: new Map(),
    };
  const view = registryView();
  fn(view);
  if (frame?.mode === "write") {
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
    change(view.custom, schema.id, immutableRegistrySchema(schema));
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
    change(view.platform, schema.id, immutableRegistrySchema(schema));
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
    change(view.edges, schema.id, immutableRegistrySchema(schema));
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
      change(view.platform, schema.id, immutableRegistrySchema(schema));
      if (family === "system") change(view.system, schema.id, true);
    }
  });
}
export function discardRegistryFrame(frame: RegistryFrame): void {
  if (selected()?.mode === "read") refuseReadMutation();
  frame.active = false;
  frame.view.permissive.clear();
  frame.view.strict.clear();
}
export function mergeRegistryFrame(frame: RegistryFrame): void {
  refuseReadMutation();
  if (
    !frame.active ||
    frame.sealed ||
    !frame.parent?.active ||
    frame.parent.sealed
  )
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
  parent.reachDirty ||= frame.reachDirty;
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
  if (selected()?.mode === "read") refuseReadMutation();
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
  if (selected()?.mode === "read") refuseReadMutation();
  committed = view;
}
export function registrySnapshotView(snapshot: RegistrySnapshot): RegistryView {
  return {
    platform: new Map(
      snapshot.platform.map((row) => [
        row.schema.id,
        immutableRegistrySchema(row.schema),
      ]),
    ),
    custom: new Map(
      snapshot.custom.map((schema) => [
        schema.id,
        immutableRegistrySchema(schema),
      ]),
    ),
    edges: new Map(
      snapshot.edges.map((schema) => [
        schema.id,
        immutableRegistrySchema(schema),
      ]),
    ),
    system: new Map(
      snapshot.platform
        .filter((row) => row.family === "system")
        .map((row) => [row.schema.id, true]),
    ),
    permissive: new Map(),
    strict: new Map(),
  };
}
export function captureCommittedRegistryView(): RegistryView {
  assertAvailable();
  if (selected())
    throw new Error("Registry capture requires an independent scope");
  return committed;
}
function guardedMap<K, V>(
  map: ReadonlyMap<K, V>,
  guard: () => void,
): ReadonlyMap<K, V> {
  const iterator = <T>(source: Iterator<T>): MapIterator<T> =>
    ({
      next() {
        guard();
        return source.next();
      },
      [Symbol.iterator]() {
        guard();
        return this;
      },
    }) as MapIterator<T>;
  const facade: ReadonlyMap<K, V> = {
    get size() {
      guard();
      return map.size;
    },
    get(key) {
      guard();
      return map.get(key);
    },
    has(key) {
      guard();
      return map.has(key);
    },
    entries() {
      guard();
      return iterator(map.entries());
    },
    keys() {
      guard();
      return iterator(map.keys());
    },
    values() {
      guard();
      return iterator(map.values());
    },
    [Symbol.iterator]() {
      return this.entries();
    },
    forEach(fn, thisArg) {
      guard();
      for (const [key, value] of this) fn.call(thisArg, value, key, this);
    },
  };
  return Object.freeze(facade);
}
function guardedCache(guard: () => void): Map<string, ZodType> {
  const capabilities = new WeakMap<object, object>();
  const validator = (value: object): boolean =>
    "_zod" in value && "parse" in value;
  const wrap = (value: object): object => {
    const existing = capabilities.get(value);
    if (existing) return existing;
    const facade = new Proxy(
      Object.create(Object.getPrototypeOf(value) as object | null) as object,
      {
        get(_target, prop) {
          guard();
          const member: unknown = Reflect.get(value, prop, value);
          if (typeof member === "function")
            return (...args: unknown[]) => {
              guard();
              const completed = (result: unknown): unknown => {
                guard();
                if (
                  result &&
                  typeof result === "object" &&
                  (!validator(value) || validator(result))
                )
                  return wrap(result);
                return result;
              };
              const result: unknown = member.apply(value, args);
              return result instanceof Promise
                ? result.then(completed)
                : completed(result);
            };
          return member && typeof member === "object" ? wrap(member) : member;
        },
        set() {
          guard();
          throw new Error("A read snapshot cannot mutate a validator");
        },
      },
    );
    capabilities.set(value, facade);
    return facade;
  };
  const map = new Map<string, ZodType>();
  const facade = new Proxy(map, {
    get(target, prop) {
      guard();
      if (prop === "set")
        return (key: string, schema: ZodType) => {
          guard();
          target.set(key, wrap(schema) as ZodType);
          return facade;
        };
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        guard();
        if (["entries", "keys", "values", Symbol.iterator].includes(prop)) {
          const iterator = value.apply(target, args) as Iterator<unknown>;
          return {
            next() {
              guard();
              return iterator.next();
            },
            [Symbol.iterator]() {
              guard();
              return this;
            },
          };
        }
        const result: unknown = value.apply(target, args);
        return result;
      };
    },
  });
  return facade;
}
export function createRegistryReadView(
  view: RegistryView,
  guard: () => void,
): RegistryView {
  return {
    platform: guardedMap(view.platform, guard),
    custom: guardedMap(view.custom, guard),
    edges: guardedMap(view.edges, guard),
    system: guardedMap(view.system, guard),
    permissive: guardedCache(guard),
    strict: guardedCache(guard),
  };
}
export function registryMapView<K, V>(
  read: () => ReadonlyMap<K, V>,
): ReadonlyMap<K, V> {
  const facade = new Proxy(new Map(), {
    get(_target, prop) {
      const scope = selected();
      const guard =
        scope?.mode === "read"
          ? () => {
              scope.assertActive();
            }
          : () => {
              registryView();
            };
      registryView();
      const map = guardedMap(read(), guard);
      if (prop === "forEach")
        return (
          fn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
          thisArg?: unknown,
        ) => {
          guard();
          for (const [key, value] of map) fn.call(thisArg, value, key, facade);
        };
      const value: unknown = Reflect.get(map, prop, map);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(map)
        : value;
    },
  }) as ReadonlyMap<K, V>;
  return facade;
}
export function registryMapFacet<
  K extends "platform" | "custom" | "edges" | "system",
>(facet: K): RegistryView[K] {
  return registryMapView(
    () => registryView()[facet] as ReadonlyMap<string, unknown>,
  ) as RegistryView[K];
}
export const registrySystemIds: ReadonlySet<string> = new Proxy(
  new Set<string>(),
  {
    get(_target, prop) {
      const map = registryMapFacet("system");
      if (prop === "has") return map.has.bind(map);
      if (prop === "size") return map.size;
      const keys = map.keys.bind(map);
      if (prop === "values" || prop === "keys" || prop === Symbol.iterator)
        return keys;
      if (prop === "entries")
        return () => {
          const source = keys();
          return {
            next() {
              const result = source.next();
              return result.done
                ? result
                : { done: false, value: [result.value, result.value] };
            },
            [Symbol.iterator]() {
              return this;
            },
          };
        };
      if (prop === "forEach")
        return (
          fn: (value: string, key: string, set: ReadonlySet<string>) => void,
          thisArg?: unknown,
        ) => {
          for (const id of keys()) fn.call(thisArg, id, id, registrySystemIds);
        };
      return undefined;
    },
  },
);

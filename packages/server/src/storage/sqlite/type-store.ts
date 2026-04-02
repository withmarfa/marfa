import { TYPE_REGISTRY, getTypeSchema } from "@myme/shared";
import type { TypeSchema } from "@myme/shared";
import type { TypeStore } from "../interface.js";

export class SqliteTypeStore implements TypeStore {
  list(): Promise<TypeSchema[]> {
    return Promise.resolve(Array.from(TYPE_REGISTRY.values()));
  }

  get(id: string): Promise<TypeSchema | undefined> {
    return Promise.resolve(getTypeSchema(id));
  }
}

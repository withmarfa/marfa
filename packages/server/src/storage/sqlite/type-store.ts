import { TYPE_REGISTRY, getTypeSchema } from "@myme/shared";
import type { TypeSchema } from "@myme/shared";
import type { TypeStore } from "../interface.js";

export class SqliteTypeStore implements TypeStore {
  list(): TypeSchema[] {
    return Array.from(TYPE_REGISTRY.values());
  }

  get(id: string): TypeSchema | undefined {
    return getTypeSchema(id);
  }
}

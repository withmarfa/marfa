import { TYPE_REGISTRY, getTypeSchema } from "@myme/shared";
import type { TypeSchema } from "@myme/shared";
import type { TypeStore } from "../interface.js";

export class PgTypeStore implements TypeStore {
  async list(): Promise<TypeSchema[]> {
    return Array.from(TYPE_REGISTRY.values());
  }

  async get(id: string): Promise<TypeSchema | undefined> {
    return getTypeSchema(id);
  }
}

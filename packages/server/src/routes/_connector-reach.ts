import { ErrorCode, MarfaError, type ApiKey } from "@withmarfa/shared";
import type { Connector, Storage } from "../storage/interface.js";

/** A source's state passes to its next key; its registrations and runs do not. */
export function connectorsForReader(key: ApiKey, storage: Storage) {
  const readable = (connector: Connector): boolean =>
    key.is_operator || connector.key_id === key.id;

  return {
    async list(): Promise<Connector[]> {
      return (await storage.connectors.list()).filter(readable);
    },
    async get(id: string): Promise<Connector> {
      const connector = await storage.connectors.get(id);
      if (!connector || !readable(connector)) {
        throw new MarfaError(
          ErrorCode.CONNECTOR_NOT_FOUND,
          "Connector not found",
        );
      }
      return connector;
    },
  };
}

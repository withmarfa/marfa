import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { Context } from "hono";
import {
  holdsPermission,
  requirePermission,
  type AppEnv,
} from "../middleware/auth.js";
import type { Connector, Storage } from "../storage/interface.js";

/** A source's state passes to its next key; its registrations and runs do not. */
export function connectorsForReader(c: Context<AppEnv>, storage: Storage) {
  const manages = holdsPermission(c, "connectors.manage");
  if (manages) requirePermission(c, "connectors.manage");
  const key = c.get("apiKey");
  const readable = (connector: Connector): boolean =>
    manages || connector.key_id === key?.id;

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

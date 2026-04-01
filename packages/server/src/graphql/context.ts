import type { ApiKey } from "@myme/shared";
import type { Storage } from "../storage/interface.js";

export interface GraphQLContext {
  apiKey: ApiKey | undefined;
  authType: "api_key" | "oauth" | undefined;
  storage: Storage;
}

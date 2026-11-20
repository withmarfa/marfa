import { createClient, CONTRACT_VERSION } from "@withmarfa/client";

export const client = createClient({
  baseUrl: "https://marfa.example.com",
  credential: "key",
});
export const version: number = CONTRACT_VERSION;

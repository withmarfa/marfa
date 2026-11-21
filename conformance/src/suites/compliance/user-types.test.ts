import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  approvedApp,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * Who may register a `user.*` type: any credential whose type map grants
 * write on `user.*`. An app reaches that through the owner's approval, so
 * this file boots a server of its own for the app's sign-in.
 */
let server: FreshServer;

beforeAll(async () => {
  server = await bootFreshServer("user-types");
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

const FIELDS = { title: { type: "string" as const } };

describe("user.* types", () => {
  it("registers a user type for an app the owner granted user.* write, recording the app as its creator", async () => {
    const app = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: (
        await approvedApp(server, ["metadata.types:write", "user.*:write"])
      ).token,
    });
    const created = await app.registerType({
      id: "user.recipe",
      fields: FIELDS,
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    expect(created.data.provenance?.created_by?.kind).toBe("app");

    const read = await app.getType("user.recipe");
    expect(read.data.provenance?.created_by).toEqual(
      created.data.provenance?.created_by,
    );
    expect(read.data.provenance?.created_by?.id).toBeTruthy();
  });

  it("refuses the same registration to an app the owner granted no user.* write", async () => {
    // The witness for the case above: the grant is what let it register.
    const app = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: (await approvedApp(server, ["metadata.types:write"])).token,
    });
    const refused = await app.registerType({
      id: "user.notebook",
      fields: FIELDS,
    });
    expect(refused.status).toBe(403);
  });
});

/**
 * Acceptance test — exercises the full vertical of the runtime substrate
 * against a real Marfa server (in-process), demonstrating that the
 * per-Integration handler → SDK → server round-trip works end-to-end.
 *
 * Cases covered:
 *   - The integration test in `packages/runtime-test` runs the same
 *     handler synchronously and asserts the same observable side effects.
 *   - A second connection's runtime credential is denied access to the
 *     first connection's `connection.runtime` subtree.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  ConnectionClient,
  createActivitySink,
  createCursorStore,
} from "@withmarfa/runtime-sdk";
import { createInMemoryStorage } from "@withmarfa/runtime-test";
import { mintLocalRuntimeCredential } from "../integrations/local-runtime/credentials.js";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

interface MintResp {
  api_key: string;
  connection_id: string;
  expires_at: string;
}

/** A fetch shim that routes `<apiUrl>/<path>` to `app.request(<path>, init)`.
 *  apiUrl is the magic prefix the SDK's ConnectionClient sees;
 *  everything past it is the path the in-process server expects. */
function makeAppFetch(app: TestContext["app"], apiUrl: string): typeof fetch {
  return (input: string | URL | Request, init?: RequestInit) => {
    const urlStr =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const path = urlStr.startsWith(apiUrl)
      ? urlStr.slice(apiUrl.length)
      : urlStr;
    return Promise.resolve(app.request(path, init));
  };
}

const ACCEPTANCE_INTEGRATION = "acme.acceptance";

async function mintRuntimeCredential(connectionId: string): Promise<MintResp> {
  // The runtime's own mint path — the supervisor's, since the HTTP mint
  // route retired with the hosted substrate.
  return mintLocalRuntimeCredential(
    ctx.storage,
    TEST_API_KEY_SALT,
    connectionId,
    "keys",
  );
}

// The mint requires a real, active system.connection.
async function createActiveConnection(): Promise<string> {
  const integration = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: ACCEPTANCE_INTEGRATION,
        manifest_version: "1.0.0",
        publisher: "Acme",
        // Deliberately not a valid manifest body. The acceptance run
        // exercises the substrate contract, not permission projection,
        // and an unresolvable manifest projects the two substrate grants
        // it needs: `system.activity` and `connection.runtime` writes.
        manifest: {},
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  const item = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
        integration_ref: integration.id,
      },
    },
    undefined,
  );
  return item.id;
}

describe("runtime substrate acceptance", () => {
  it("end-to-end: handler reads cursor → writes cursor → emits activity", async () => {
    // 1. Create the Connection.
    const connectionId = await createActiveConnection();

    // 2. Mint a runtime credential for this Connection.
    const minted = await mintRuntimeCredential(connectionId);

    // 3. Build a ConnectionClient pointed at the in-process server.
    const apiUrl = "http://acceptance.local";
    const client = new ConnectionClient({
      apiUrl,
      credential: {
        api_key: minted.api_key,
        expires_at: minted.expires_at,
        connection_id: connectionId,
      },
      refreshCredential: () =>
        Promise.resolve({
          api_key: minted.api_key,
          expires_at: minted.expires_at,
          connection_id: connectionId,
        }),
      fetch: makeAppFetch(ctx.app, apiUrl),
    });

    // 4. Drive a handler-equivalent flow: read cursor → write cursor →
    //    emit activity. This is exactly what _template's handleSchedule
    //    does, with the in-memory storage shim from runtime-test
    //    standing in for the per-Connection DO storage.
    const localStorage = createInMemoryStorage();
    const cursor = createCursorStore(localStorage);
    const activity = createActivitySink(client, connectionId);

    // 4a. Cursor starts null on first run.
    const initialCursor = await cursor.read("main");
    expect(initialCursor).toBeNull();

    // 4b. Sync cursor to the server's connection.runtime extension.
    const cursorBlob = {
      main: {
        last_run_at: "2026-05-01T00:00:00Z",
        run_count: 1,
      },
    };
    await client.writeRuntimeExtension(connectionId, cursorBlob);

    // 4c. Round-trip: server should now hold the blob.
    const serverBlob = await client.readRuntimeExtension(connectionId);
    expect(serverBlob).toEqual(cursorBlob);

    // 4d. Emit a system.activity row.
    await activity.emit({
      severity: "info",
      summary: "Acceptance run completed",
      detail: { run_count: 1 },
    });

    // 5. Verify the activity item landed.
    const listRes = await request(
      ctx.app,
      "GET",
      `/items?type=system.activity&limit=50`,
      { key: ctx.adminKey },
    );
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as {
      data: { id: string; properties?: Record<string, unknown> }[];
    };
    const matching = listed.data.find(
      (i) =>
        (i.properties as { connection_id?: string } | undefined)
          ?.connection_id === connectionId,
    );
    expect(matching).toBeDefined();
    expect(matching?.properties).toMatchObject({
      severity: "info",
      summary: "Acceptance run completed",
    });
  });

  it("step 5 — cross-connection runtime credential is denied", async () => {
    // Create two distinct active Connections.
    const connA = await createActiveConnection();
    const connB = await createActiveConnection();

    // Mint a runtime credential bound to A.
    const credA = await mintRuntimeCredential(connA);

    // Try to use credA against B's runtime subtree — should 403.
    const apiUrl = "http://acceptance.local";
    const client = new ConnectionClient({
      apiUrl,
      credential: {
        api_key: credA.api_key,
        expires_at: credA.expires_at,
        connection_id: connA,
      },
      refreshCredential: () =>
        Promise.resolve({
          api_key: credA.api_key,
          expires_at: credA.expires_at,
          connection_id: connA,
        }),
      fetch: makeAppFetch(ctx.app, apiUrl),
    });

    let threw: unknown = null;
    try {
      await client.writeRuntimeExtension(connB, { key: 1 });
    } catch (err) {
      threw = err;
    }
    expect(threw).not.toBeNull();
    expect(String(threw)).toMatch(/403|forbidden|cross|connection_id/i);
  });
});

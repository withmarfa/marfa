import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  startDeviceFlow,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * A device asking for a code and polling for its token, with a person
 * approving in between. The device holds no credential at any step; the
 * approval needs the owner signed in, and an instance has one owner, which
 * the run's shared server does not have, so this file boots a server of its
 * own and creates the owner there.
 */
let server: FreshServer | undefined;

beforeAll(async () => {
  server = await bootFreshServer("device-grant");
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

/** A poller leaves the interval between polls; a sooner one is told to slow
 *  down rather than answered on the code's state. */
function waitOut(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 250));
}

describe("the device authorization grant", () => {
  it("answers a poll by the code's state: pending, then a token, then invalid_grant once it is spent", async () => {
    const flow = await startDeviceFlow(server!, ["core.note:read"]);

    // Nobody has decided yet.
    const pending = await flow.poll();
    expect(pending.status).toBe(400);
    expect(pending.body.error).toBe("authorization_pending");
    expect(pending.body.access_token).toBeUndefined();

    await flow.approve();
    await waitOut(flow.interval);
    const approved = await flow.poll();
    expect(approved.status).toBe(200);
    expect(approved.body.access_token).toBeTruthy();
    expect(approved.body.token_type?.toLowerCase()).toBe("bearer");
    expect(approved.body.scope).toBe("core.note:read");

    // The witness for the refusal below: the same code was answered with a
    // token a poll ago, so it is the exchange that spent it.
    await waitOut(flow.interval);
    const reused = await flow.poll();
    expect(reused.status).toBe(400);
    expect(reused.body.error).toBe("invalid_grant");
    expect(reused.body.access_token).toBeUndefined();
  });
});

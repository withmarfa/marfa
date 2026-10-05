import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  startDeviceFlow,
  type DeviceFlow,
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
  // One code, taken through its states in order: each test leaves it where
  // the next one starts.
  let flow: DeviceFlow;

  it("answers authorization_pending to a poll of a code nobody has decided", async () => {
    flow = await startDeviceFlow(server!, ["core.note:read"]);
    const pending = await flow.poll();
    expect(pending.status).toBe(400);
    expect(pending.body.error).toBe("authorization_pending");
    expect(pending.body.access_token).toBeUndefined();
  });

  it("answers the first poll after the approval, an interval after the last, with an access token for the approved scopes", async () => {
    await flow.approve();
    await waitOut(flow.interval);
    const approved = await flow.poll();
    expect(approved.status).toBe(200);
    expect(approved.body.access_token).toBeTruthy();
    expect(approved.body.token_type?.toLowerCase()).toBe("bearer");
    expect(approved.body.scope).toBe("core.note:read");
  });

  it("answers invalid_grant to a poll of a code a token was already issued for", async () => {
    // The witness: the previous test had this code answered with a token, so
    // it is that exchange that spent it. No wait: a spent code is refused
    // whatever the time since the last poll.
    const reused = await flow.poll();
    expect(reused.status).toBe(400);
    expect(reused.body.error).toBe("invalid_grant");
    expect(reused.body.access_token).toBeUndefined();
  });
});

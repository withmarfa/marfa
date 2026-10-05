import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * A housekeeping job never overlaps itself: a run asked for while one is in
 * the middle of its work is refused `409 housekeeping_job_running`.
 *
 * **A run held open from outside.** The heartbeat job's whole work is one
 * request to a URL the operator names. The fixture names a receiver of its
 * own that takes the request and does not answer, so the run the scheduler
 * starts on its own at boot stays in the middle of its work for as long as
 * the fixture says. Nothing else on the instance holds a run open for a time
 * a fixture sets.
 *
 * A server of its own, because the receiver is a setting.
 */
let server: FreshServer | undefined;
let receiver: Server | undefined;

/** Requests the receiver has taken and not yet answered. */
const held: ServerResponse[] = [];
let received = 0;
/** Whether a request is answered at once, as it is once the file lets go. */
let answerAtOnce = false;

beforeAll(async () => {
  receiver = createServer((_request: IncomingMessage, response) => {
    received += 1;
    if (answerAtOnce) {
      response.writeHead(204).end();
    } else {
      held.push(response);
    }
  });
  await new Promise<void>((resolve) =>
    receiver!.listen(0, "127.0.0.1", resolve),
  );
  const address = receiver.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("the receiver did not bind to a port");
  }
  server = await bootFreshServer("housekeeping-job-running", {
    MARFA_HEARTBEAT_URL: `http://127.0.0.1:${String(address.port)}/beat`,
    // Past the file, so the one run in it is the one the boot starts.
    MARFA_HEARTBEAT_INTERVAL_MS: "3600000",
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  answerAtOnce = true;
  for (const response of held) response.writeHead(204).end();
  await server?.stop();
  await new Promise<void>((resolve) => {
    if (receiver === undefined) resolve();
    else receiver.close(() => resolve());
    receiver?.closeAllConnections();
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

async function runHeartbeat(): Promise<Response> {
  return fetch(`${server!.apiUrl}/housekeeping/heartbeat/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${server!.operatorKey}` },
  });
}

async function listedHeartbeat(): Promise<{ running_since: string | null }> {
  const listed = await fetch(`${server!.apiUrl}/housekeeping`, {
    headers: { Authorization: `Bearer ${server!.operatorKey}` },
  });
  expect(listed.status).toBe(200);
  const body = (await listed.json()) as {
    data: { name: string; running_since: string | null }[];
  };
  const row = body.data.find((job) => job.name === "heartbeat");
  expect(row, "the instance lists no heartbeat job").toBeDefined();
  return row!;
}

describe("POST /housekeeping/{name}/run while the job is in the middle of a run", () => {
  it("answers 409 housekeeping_job_running, and runs once the earlier run has ended", async () => {
    // The scheduler starts the heartbeat on its own at boot, and the receiver
    // holds that request, so the run is in the middle of its work.
    const deadline = Date.now() + 60_000;
    while (received === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(received, "the scheduler never started the heartbeat").toBe(1);
    expect((await listedHeartbeat()).running_since).not.toBeNull();

    const refused = await runHeartbeat();
    expect(refused.status).toBe(409);
    expect(refused.headers.get("X-Error-Code")).toBe(
      "housekeeping_job_running",
    );
    const body = (await refused.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("housekeeping_job_running");
    // The refused request started nothing: the receiver still holds the one.
    expect(received).toBe(1);

    // The witness: the same request is answered once the run has ended, so
    // the refusal was the overlap and not the job or the door.
    answerAtOnce = true;
    for (const response of held.splice(0)) response.writeHead(204).end();
    let ended = await runHeartbeat();
    for (let attempt = 0; attempt < 200 && ended.status === 409; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      ended = await runHeartbeat();
    }
    expect(ended.status).toBe(200);
    expect(await ended.json()).toMatchObject({
      name: "heartbeat",
      outcome: "ok",
    });
    expect((await listedHeartbeat()).running_since).toBeNull();
  });
});

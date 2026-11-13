import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { HOUR_MS, movedClock, operatorOf } from "../../utils/moved-clock.js";
import { declareOversizeBody } from "../../utils/oversize.js";
import { DISK_ONLY } from "../../utils/own-blob-server.js";
import { inParts, pause, slowPost } from "../../utils/slow-body.js";
import { tuning } from "../../utils/tuning.js";

// Shorten both limits so a progressing upload can outlast the body deadline.
const DEADLINE_MS = 3000;
const BULK_CAP = 16 * 1024 * 1024;
const JSON_HEADERS = { "content-type": "application/json" };

let server: FreshServer;

beforeAll(async () => {
  server = await bootFreshServer("public-body", {
    ...DISK_ONLY,
    ...tuning(`body_deadline_ms=${String(DEADLINE_MS)}`, "upload_idle_ms=2000"),
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

function bearer(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

/** A declared body of the bulk cap, of which nothing is sent. */
function heldBulk(headers: Record<string, string>) {
  return declareOversizeBody(`${server.apiUrl}/items/bulk`, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...headers },
    bytes: BULK_CAP,
  });
}

describe("a body the public listener reads whole", () => {
  it("is answered 408 request_timeout with the connection closed when it has not arrived by the deadline, and is taken when it arrives in time", async () => {
    const note = Buffer.from(
      JSON.stringify({ type: "core.note", properties: { body: "late" } }),
    );
    const [first, rest] = inParts(note, 2);
    const headers = { ...JSON_HEADERS, ...bearer(server.workingKey) };

    const late = slowPost({ apiUrl: server.apiUrl }, "/items", headers);
    const started = Date.now();
    await late.write(first!);
    const answered = await late.answered;
    expect(Date.now() - started).toBeGreaterThanOrEqual(DEADLINE_MS - 100);
    expect(answered.status, answered.body).toBe(408);
    expect(JSON.parse(answered.body).error.code).toBe("request_timeout");
    expect(answered.headers.connection).toBe("close");

    // The witness: the same body, slow but whole within the deadline.
    const slow = slowPost({ apiUrl: server.apiUrl }, "/items", headers);
    await slow.write(first!);
    await pause(DEADLINE_MS / 3);
    await slow.write(rest!);
    slow.end();
    const taken = await slow.answered;
    expect(taken.status, taken.body).toBe(201);
  }, 30_000);

  it("leaves a blob upload whose parts keep arriving to its own idle limit, past the deadline", async () => {
    const bytes = Buffer.from(
      "a blob that outlasts the deadline ".repeat(2000),
    );
    const upload = slowPost({ apiUrl: server.apiUrl }, "/blobs", {
      "content-type": "application/octet-stream",
      ...bearer(server.workingKey),
    });
    const started = Date.now();
    for (const part of inParts(bytes, 6)) {
      await upload.write(part);
      await pause(1000);
    }
    upload.end();
    const answered = await upload.answered;
    expect(Date.now() - started).toBeGreaterThan(DEADLINE_MS);
    expect(answered.status, answered.body).toBe(201);
  }, 30_000);
});

describe("an operation that needs a credential", () => {
  it("answers 401 unauthorized to a declared body before any of it is sent, when no credential comes with it", async () => {
    const started = Date.now();
    const refused = await heldBulk({});
    expect(Date.now() - started).toBeLessThan(DEADLINE_MS);
    expect(refused.status, refused.body).toBe(401);
    expect(JSON.parse(refused.body).error.code).toBe("unauthorized");

    // The witness: with a key, the server waits for the body until its deadline.
    const read = await heldBulk(bearer(server.workingKey));
    expect(Date.now() - started).toBeGreaterThanOrEqual(DEADLINE_MS - 100);
    expect(read.status, read.body).toBe(408);
  }, 30_000);

  it("answers 401 naming the expiry to a key past its expires_at before any of the body is sent", async () => {
    const minted = await operatorOf(server).createKey({
      label: "brief",
      source: "brief",
      expires_at: new Date(Date.now() + HOUR_MS).toISOString(),
    });
    expect(minted.status, JSON.stringify(minted.error)).toBe(201);
    await movedClock(server).advance(2 * HOUR_MS);

    const started = Date.now();
    const refused = await heldBulk(bearer(minted.data.key));
    expect(Date.now() - started).toBeLessThan(DEADLINE_MS);
    expect(refused.status, refused.body).toBe(401);
    expect(JSON.parse(refused.body).error.details).toEqual({
      expired_at: minted.data.expires_at,
    });
  }, 30_000);
});

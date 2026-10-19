import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { MarfaClient } from "../../client/api.js";
import { itemsArchive } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { clientsFor } from "../../utils/own-blob-server.js";
import { inParts, pause, slowPost } from "../../utils/slow-body.js";
import { issuerOrigin, signIn } from "../../utils/signed-in.js";

/**
 * When the owner's sign-in is judged for a restore whose body takes a while
 * to arrive. The five minutes are counted from the request's start; the
 * server's clock is moved forward while the body is on its way, and the clock
 * only goes forward, so each case signs in afresh, just before it begins.
 */
const MINUTE = 60 * 1000;

let server: FreshServer;
let origin: string;
let working: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("restore-upload-sign-in");
  origin = await issuerOrigin(server);
  ({ working } = clientsFor(server));
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

/** A restore from `cookie`, whose body is sent in four parts. */
function restoreFrom(cookie: string) {
  const id = uuidv7();
  const archive = itemsArchive([
    {
      id,
      type: "core.note",
      properties: { body: "restored by a long upload" },
      source: "restore-upload-sign-in",
    },
  ]);
  const parts = inParts(archive, 4);
  const upload = slowPost({ apiUrl: server.apiUrl }, "/restore", {
    cookie,
    origin,
    "content-type": "application/gzip",
  });
  return {
    id,
    upload,
    first: async () => {
      await upload.write(parts[0]!);
      // The server reads nothing of the body before it has judged the sign-in.
      await pause(1000);
    },
    rest: async () => {
      for (const part of parts.slice(1)) await upload.write(part);
      upload.end();
    },
  };
}

describe("a restore whose upload crosses the five minutes", () => {
  it("restores an archive from an owner who signed in four minutes before the request started and whose body finished arriving two minutes later", async () => {
    const cookie = await signIn(server, origin);
    await server.advanceClock(4 * MINUTE);
    const restore = restoreFrom(cookie);
    await restore.first();
    await server.advanceClock(2 * MINUTE);
    await restore.rest();
    const answered = await restore.upload.answered;
    expect(answered.status, answered.body).toBe(200);
    expect(JSON.parse(answered.body)).toMatchObject({ imported: 1 });
    expect((await working.getItem(restore.id)).status).toBe(200);
  });

  it("refuses with 403 forbidden an owner who signed in six minutes before the request started, as soon as the request starts", async () => {
    const cookie = await signIn(server, origin);
    await server.advanceClock(6 * MINUTE);
    const restore = restoreFrom(cookie);
    await restore.first();
    // The answer comes with the body unfinished: nothing waits for its end.
    const answered = await restore.upload.answered;
    expect(answered.status, answered.body).toBe(403);
    expect(JSON.parse(answered.body).error.code).toBe("forbidden");
    expect((await working.getItem(restore.id)).status).toBe(404);
  });
});

describe("a restore whose owner signs out during the upload", () => {
  it("answers 401 unauthorized, though the sign-in was recent when the request started", async () => {
    const cookie = await signIn(server, origin);
    const restore = restoreFrom(cookie);
    await restore.first();
    const ended = await fetch(`${server.apiUrl}/auth/sign-out`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: "{}",
    });
    expect(ended.status).toBe(200);
    await restore.rest();
    const answered = await restore.upload.answered;
    expect(answered.status, answered.body).toBe(401);
    expect(JSON.parse(answered.body).error.code).toBe("unauthorized");
  });

  it("writes nothing of the archive", async () => {
    const cookie = await signIn(server, origin);
    const restore = restoreFrom(cookie);
    await restore.first();
    await fetch(`${server.apiUrl}/auth/sign-out`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: "{}",
    });
    await restore.rest();
    await restore.upload.answered;
    expect((await working.getItem(restore.id)).status).toBe(404);

    // The same archive from a session that stays signed in is restored, so
    // the sign-out alone kept it out.
    const again = await signIn(server, origin);
    const whole = restoreFrom(again);
    await whole.first();
    await whole.rest();
    expect((await whole.upload.answered).status).toBe(200);
    expect((await working.getItem(whole.id)).status).toBe(200);
  });
});

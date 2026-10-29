import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as clock from "../clock.js";
import {
  createTestContext,
  type TestContext,
  cleanupTestContext,
} from "../test-utils.js";

const MINUTE = 60_000;

let source: TestContext;
let archive: Uint8Array;
let noteId: string;

beforeAll(async () => {
  source = await createTestContext();
  const written = await source.app.request("/items", {
    method: "POST",
    headers: {
      authorization: `Bearer ${source.workingKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: "core.note",
      properties: { body: "kept through a long upload" },
    }),
  });
  expect(written.status).toBe(201);
  noteId = ((await written.json()) as { item: { id: string } }).item.id;
  const exported = await source.ownerRequest("/export?format=archive");
  expect(exported.status).toBe(200);
  archive = new Uint8Array(await exported.arrayBuffer());
});

afterAll(async () => {
  await cleanupTestContext(source);
});

/** An instance that does not hold the note, with its owner signed in `minutes` ago. */
async function instanceSignedInAgo(minutes: number): Promise<TestContext> {
  const instance = await createTestContext();
  await (
    instance.storage as typeof instance.storage & {
      __sqliteRun: (statement: string, params: unknown[]) => Promise<unknown>;
    }
  ).__sqliteRun("UPDATE auth_session SET created_at = ?", [
    Math.floor(clock.nowMs() / 1000) - minutes * 60,
  ]);
  return instance;
}

async function holds(instance: TestContext): Promise<boolean> {
  const read = await instance.app.request(`/items/${noteId}`, {
    headers: { authorization: `Bearer ${instance.workingKey}` },
  });
  return read.status === 200;
}

/**
 * A restore whose body the test releases in two parts. `underway` settles
 * once the server has asked for the second part, which is when the upload
 * is in progress and the test may move the clock or end the session.
 */
function slowRestore(from: TestContext) {
  const half = Math.floor(archive.length / 2);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let asked!: () => void;
  const underway = new Promise<void>((resolve) => {
    asked = resolve;
  });
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(archive.slice(0, half));
        return;
      }
      asked();
      await gate;
      controller.enqueue(archive.slice(half));
      controller.close();
    },
  });
  const response = from.app.request("/restore", {
    method: "POST",
    headers: {
      cookie: from.owner.cookie,
      origin: new URL(from.config.authBaseUrl).origin,
      "content-type": "application/gzip",
    },
    body,
    duplex: "half",
  });
  return { response, underway, finish };
}

describe("POST /restore sign-in recency during a long upload", () => {
  it("restores an upload that began inside the five minutes and ended outside them", async () => {
    const instance = await instanceSignedInAgo(4);
    try {
      expect(await holds(instance)).toBe(false);
      const upload = slowRestore(instance);
      await upload.underway;
      clock.advanceClock(2 * MINUTE);
      upload.finish();
      const answered = await upload.response;
      expect(answered.status).toBe(200);
      expect(await answered.json()).toMatchObject({ imported: 1 });
      expect(await holds(instance)).toBe(true);
    } finally {
      await instance.cleanup();
    }
  });

  it("refuses an upload that began outside the five minutes before it reads the body", async () => {
    const instance = await instanceSignedInAgo(6);
    try {
      const upload = slowRestore(instance);
      const answered = await upload.response;
      expect(answered.status).toBe(403);
      upload.finish();
      expect(await holds(instance)).toBe(false);
    } finally {
      await instance.cleanup();
    }
  });

  it("refuses an upload whose session ended while it uploaded, and writes nothing", async () => {
    const instance = await instanceSignedInAgo(1);
    try {
      const upload = slowRestore(instance);
      await upload.underway;
      const ended = await instance.ownerRequest("/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(ended.status).toBe(200);
      upload.finish();
      const answered = await upload.response;
      expect(answered.status).toBe(401);
      expect(
        ((await answered.json()) as { error: { code: string } }).error.code,
      ).toBe("unauthorized");
      expect(await holds(instance)).toBe(false);
    } finally {
      await instance.cleanup();
    }
  });
});

import { once } from "node:events";
import { serve } from "@hono/node-server";
import { expect, it } from "vitest";
import { createTestContext, request } from "./test-utils.js";

/** Hold one real route's awaited read while a second HTTP request completes. */
async function witnessConcurrentReads(
  serialize: boolean,
  budgetMs: number,
): Promise<void> {
  const ctx = await createTestContext();
  const original = ctx.storage.items.list.bind(ctx.storage.items);
  let confirmEntered: () => void = () => undefined;
  let releaseGate: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    confirmEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let first = true;
  let firstFinished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending: Promise<unknown>[] = [];
  ctx.storage.items.list = async (...args) => {
    if (first) {
      first = false;
      confirmEntered();
      await gate;
    }
    return original(...args);
  };
  // The negative control runs the same socket/route/storage path behind a
  // deliberate request queue. It must fail the witness, not a speed ratio.
  let queue = Promise.resolve();
  const server = serve({
    fetch: (incoming, env) => {
      if (!serialize) return ctx.app.fetch(incoming, env);
      const response = queue.then(() => ctx.app.fetch(incoming, env));
      queue = response.then(
        () => undefined,
        () => undefined,
      );
      return response;
    },
    port: 0,
    hostname: "127.0.0.1",
  });
  try {
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("HTTP fixture has no port");
    const made = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { title: "concurrent read", body: "known content" },
      },
    });
    expect(made.status).toBe(201);
    const created = (await made.json()) as { item: { id: string } };
    const url = `http://127.0.0.1:${String(address.port)}/items?limit=1`;
    const headers = { Authorization: `Bearer ${ctx.workingKey}` };
    const read = async () => {
      const response = await fetch(url, { headers });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: { id: string; properties: { title: string; body: string } }[];
      };
      expect(body.data).toEqual([
        expect.objectContaining({
          id: created.item.id,
          properties: { title: "concurrent read", body: "known content" },
        }),
      ]);
    };
    const firstRead = read().finally(() => {
      firstFinished = true;
    });
    pending.push(firstRead);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error("second HTTP read did not complete while first was held"),
        );
      }, budgetMs);
    });
    await Promise.race([entered, timeout]);
    const secondRead = read();
    pending.push(secondRead);
    await Promise.race([secondRead, timeout]);
    expect(firstFinished).toBe(false);
    releaseGate();
    await firstRead;
  } finally {
    clearTimeout(timer);
    releaseGate();
    await Promise.allSettled(pending);
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
    await ctx.cleanup();
  }
}

it("completes a correct HTTP read while another route read is held", async () => {
  await witnessConcurrentReads(false, 5_000);
});

it("rejects deliberate serialization of the actual HTTP request path", async () => {
  await expect(witnessConcurrentReads(true, 250)).rejects.toThrow(
    "second HTTP read did not complete while first was held",
  );
});

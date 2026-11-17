import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { afterEach, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { bootFreshServer, type FreshServer } from "../../utils/fresh-server.js";
import { waitFor } from "../../utils/wait.js";

/**
 * A delivery's attempt settles that delivery alone, even when a subscription
 * is deleted and made again while the attempt is in flight.
 */
let server: FreshServer | undefined;
let receiver: Server | undefined;
const sockets = new Set<Socket>();

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await new Promise<void>((resolve) => {
    if (receiver) receiver.close(() => resolve());
    else resolve();
  });
  receiver = undefined;
  await server?.stop();
  server = undefined;
}, 120_000);

interface Arrival {
  path: string;
  body: string;
  at: number;
}

async function start(answers: boolean) {
  server = await bootFreshServer("webhook-attempt-identity");
  const arrivals: Arrival[] = [];
  receiver = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      arrivals.push({ path: request.url ?? "", body, at: Date.now() });
      if (answers) response.end("ok");
    });
  });
  receiver.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) =>
    receiver!.listen(0, "127.0.0.1", resolve),
  );
  const address = receiver.address();
  if (!address || typeof address === "string") {
    throw new Error("no receiver port");
  }
  const writer = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  const subscribe = async (path: string) => {
    const made = await writer.createWebhook({
      url: `http://127.0.0.1:${String(address.port)}${path}`,
      events: ["item.created"],
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    return made.data.id;
  };
  const note = async (body: string) => {
    const made = await writer.createItem({
      type: "core.note",
      properties: { body },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    return made.data.item.id;
  };
  const rows = async (subscription: string) => {
    const listed = await writer.listWebhookDeliveries(subscription);
    expect(listed.status).toBe(200);
    return listed.data.data;
  };
  const arrived = (path: string) => arrivals.filter((a) => a.path === path);
  return { writer, arrivals, arrived, subscribe, note, rows };
}

it("settles a delivery only by its own attempt after a subscription is deleted during an attempt and made again", async () => {
  const { writer, arrived, subscribe, note, rows } = await start(true);
  await server!.setFault("hold:webhook:response");
  const old = await subscribe("/old");
  await note("attempt of a deleted subscription");
  await waitFor("the old attempt", async () =>
    arrived("/old").length > 0 ? true : undefined,
  );
  await server!.waitForHold("hold:webhook:response", 1);
  const gone = await writer.deleteWebhook(old);
  expect(gone.status).toBe(200);

  const fresh = await subscribe("/new");
  const item = await note("delivery of the new subscription");
  // The old attempt is still in flight and holds nothing back.
  await waitFor(
    "the new receiver to be called while the old attempt is in flight",
    async () => (arrived("/new").length > 0 ? true : undefined),
    15_000,
  );
  expect(arrived("/new")[0]!.body).toContain(item);
  await server!.waitForHold("hold:webhook:response", 2);
  const before = await rows(fresh);
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({ status: "pending", attempt: 0 });

  await server!.clearFault("hold:webhook:response");
  const settled = await waitFor("the new delivery to settle", async () => {
    const [row] = await rows(fresh);
    return row?.status === "succeeded" ? row : undefined;
  });
  expect(settled.attempt).toBe(1);
  expect(arrived("/new")).toHaveLength(1);
  expect(arrived("/old")).toHaveLength(1);
}, 180_000);

it("counts no attempt on a delivery that did not make it when several attempts to a receiver that never answers end after subscriptions are deleted and made again", async () => {
  const { writer, arrived, subscribe, note, rows } = await start(false);
  const first = await subscribe("/first");
  await note("first silent delivery");
  const firstAt = (
    await waitFor("the first attempt", async () => arrived("/first")[0])
  ).at;
  await writer.deleteWebhook(first);
  // The second attempt starts 3 seconds after the first, so it is still in flight when the first ends.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const second = await subscribe("/second");
  await note("second silent delivery");
  const secondAt = (
    await waitFor("the second attempt", async () => arrived("/second")[0])
  ).at;
  expect(secondAt).toBeGreaterThan(firstAt + 3_000);
  const firstEnds = firstAt + 10_000;
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, firstEnds + 1_500 - Date.now())),
  );
  // Only the first attempt has ended; the second is still in flight.
  expect(await rows(second)).toMatchObject([{ status: "pending", attempt: 0 }]);
  const ended = await waitFor(
    "the second attempt to end",
    async () => {
      const [row] = await rows(second);
      return row?.attempt === 1 ? row : undefined;
    },
    20_000,
  );
  expect(ended).toMatchObject({
    status: "pending",
    error: "The receiver did not answer in time.",
  });
  expect(arrived("/second")).toHaveLength(1);
}, 180_000);

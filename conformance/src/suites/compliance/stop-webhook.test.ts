import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { waitFor } from "../../utils/wait.js";
import { bootFreshServer, type FreshServer } from "../../utils/fresh-server.js";

let server: FreshServer | undefined;
let receiver: Server | undefined;

afterEach(async () => {
  receiver?.closeAllConnections();
  await new Promise<void>((resolve) => {
    if (receiver) receiver.close(() => resolve());
    else resolve();
  });
  await server?.stop();
}, 120_000);

async function delivery(answer: boolean) {
  server = await bootFreshServer("stop-webhook");
  const bodies: string[] = [];
  let arrived!: () => void;
  const received = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  receiver = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      bodies.push(body);
      if (answer) response.end("ok");
      arrived();
    });
  });
  await new Promise<void>((resolve) =>
    receiver!.listen(0, "127.0.0.1", resolve),
  );
  const address = receiver.address();
  if (!address || typeof address === "string")
    throw new Error("no receiver port");
  const writer = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  const subscription = await writer.createWebhook({
    url: `http://127.0.0.1:${String(address.port)}/hook`,
    events: ["item.created"],
  });
  expect(subscription.status, JSON.stringify(subscription.error)).toBe(201);
  const item = await writer.createItem({
    type: "core.note",
    properties: { body: "deliver before stopping" },
  });
  expect(item.status).toBe(201);
  await received;
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toContain(item.data.item.id);
  return { writer, subscription: subscription.data.id, bodies };
}

it("records a webhook delivery released by shutdown before closing storage", async () => {
  const { writer, subscription, bodies } = await delivery(true);
  // A second event gives the completed first delivery as a witness.
  await waitFor("the first delivery record", async () => {
    const first = await writer.listWebhookDeliveries(subscription);
    return first.data.data.some((row) => row.status === "success")
      ? true
      : undefined;
  });
  await server!.setFault("hold:webhook:response");
  const item = await writer.createItem({
    type: "core.note",
    properties: { body: "held delivery" },
  });
  expect(item.status).toBe(201);
  await server!.waitForHold("hold:webhook:response");
  const before = await writer.listWebhookDeliveries(subscription);
  expect(before.data.data.some((row) => row.status === "success")).toBe(true);
  expect(before.data.data.some((row) => row.status === "pending")).toBe(true);
  const ended = await server!.restart({ signal: "SIGTERM" });
  expect(ended.code).toBe(0);
  expect(ended.ms).toBeLessThan(8_000);
  const after = await new MarfaClient({
    baseUrl: server!.apiUrl,
    apiKey: server!.workingKey,
  }).listWebhookDeliveries(subscription);
  expect(after.status).toBe(200);
  expect(after.data.data).toHaveLength(2);
  for (const row of after.data.data) expect(row.status).toBe("success");
  expect(bodies).toHaveLength(2);
}, 180_000);

it("exits 0 when an unanswered webhook keeps housekeeping past the stop wait", async () => {
  const { writer, subscription } = await delivery(false);
  const before = await writer.listWebhookDeliveries(subscription);
  expect(before.status).toBe(200);
  expect(before.data.data).toHaveLength(1);
  expect(before.data.data[0]!.status).toBe("pending");
  server!.signal("SIGTERM");
  const ended = await server!.exit();
  // The peer never answered: a successful exit after the work budget proves
  // that housekeeping outlived that wait, without timing a synthetic sleep.
  expect(ended.ms).toBeGreaterThanOrEqual(4_000);
  expect(ended.ms).toBeLessThan(8_000);
  expect(ended.code).toBe(0);
}, 180_000);

import { fork, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createTestContext } from "../test-utils.js";

interface Message {
  kind: string;
  url?: string;
}
function next(child: ChildProcess, kind: string): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", receive);
      reject(new Error(`child did not report ${kind}`));
    }, 10_000);
    const receive = (message: Message) => {
      if (message.kind !== kind) return;
      clearTimeout(timer);
      child.off("message", receive);
      resolve(message);
    };
    child.on("message", receive);
  });
}

async function crashWitness(partial: boolean) {
  const ctx = await createTestContext();
  const children: ChildProcess[] = [];
  const received: string[] = [];
  const receivedPaths: string[] = [];
  const receiver = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      received.push(body);
      receivedPaths.push(request.url ?? "");
      response.writeHead(200);
      response.end();
    });
  });
  await new Promise<void>((resolve) =>
    receiver.listen(0, "127.0.0.1", resolve),
  );
  const receiverUrl = `http://127.0.0.1:${String((receiver.address() as AddressInfo).port)}/`;
  const boot = async () => {
    const child = fork(
      new URL(
        "../../scripts/test-fixtures/webhook-cursor-crash.ts",
        import.meta.url,
      ),
      [],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    children.push(child);
    child.stdout?.on("data", (data: Buffer) => {
      process.stdout.write(data);
    });
    child.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(data);
    });
    const ready = next(child, "ready");
    child.send({
      dir: ctx.tmpDir,
      config: { ...ctx.config, webhookAllowPrivateAddresses: true },
    });
    const { url } = await ready;
    if (!url) throw new Error("child has no URL");
    return { child, url };
  };
  const send = (url: string, path: string, body: unknown) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    const first = await boot();
    const registered = await send(first.url, "/webhooks", {
      url: `${receiverUrl}0`,
      events: ["item.created"],
    });
    expect(registered.status).toBe(201);
    const subscription = (await registered.json()) as { id: string };
    const control = await send(first.url, "/items", {
      type: "core.note",
      properties: { body: "receiver control" },
    });
    expect(control.status).toBe(201);
    const controlled = (await control.json()) as { item: { id: string } };
    const drained = next(first.child, "passed");
    first.child.send({ kind: "pass" });
    await drained;
    expect(received.some((body) => body.includes(controlled.item.id))).toBe(
      true,
    );
    const subscriptions = [subscription.id];
    if (partial) {
      for (let n = 1; n <= 50; n++) {
        const registered = await send(first.url, "/webhooks", {
          url: `${receiverUrl}${String(n)}`,
          events: ["item.created"],
        });
        expect(registered.status).toBe(201);
        subscriptions.push(((await registered.json()) as { id: string }).id);
      }
    } else {
      const armed = next(first.child, "armed");
      first.child.send({ kind: "arm" });
      await armed;
    }

    const answer = await send(first.url, "/items", {
      type: "core.note",
      properties: { body: "durable crash witness" },
    });
    expect(answer.status).toBe(201);
    const { item } = (await answer.json()) as { item: { id: string } };
    if (partial) {
      const page = next(first.child, "passed");
      first.child.send({ kind: "pass" });
      await page;
      const position = await ctx.storage.outboundWebhooks.checkpoint();
      expect(position.lastEventId).toBe(1n);
      expect(position.eventId).toBe(2n);
      expect(position.afterSubscriptionId).not.toBeNull();
      expect(received.filter((body) => body.includes(item.id))).toHaveLength(
        50,
      );
      const armed = next(first.child, "armed");
      first.child.send({ kind: "arm" });
      await armed;
    }
    const blocked = next(first.child, "blocked");
    first.child.send({ kind: "pass" });
    await blocked;
    const events = await ctx.storage.eventLog.getAfter(0n, 100);
    expect(events.some((event) => event.item_id === item.id)).toBe(true);
    if (!partial)
      expect(
        (
          await ctx.storage.outboundWebhookDeliveries.list(subscription.id, {
            limit: 100,
          })
        ).data,
      ).toHaveLength(1);
    const killed = once(first.child, "exit");
    first.child.kill("SIGKILL");
    await killed;
    const restarted = await boot();
    const passed = next(restarted.child, "passed");
    restarted.child.send({ kind: "pass" });
    await passed;
    expect(
      received.map(
        (body) => (JSON.parse(body) as { item: { id: string } }).item.id,
      ),
    ).toContain(item.id);
    expect(received.filter((body) => body.includes(item.id))).toHaveLength(
      subscriptions.length,
    );
    for (const [index, id] of subscriptions.entries()) {
      expect(
        (await ctx.storage.outboundWebhookDeliveries.list(id, { limit: 100 }))
          .data,
      ).toHaveLength(index === 0 ? 2 : 1);
      expect(
        receivedPaths.filter(
          (path, n) =>
            path === `/${String(index)}` && received[n]?.includes(item.id),
        ),
      ).toHaveLength(1);
    }
    expect((await ctx.storage.outboundWebhooks.checkpoint()).lastEventId).toBe(
      2n,
    );
  } finally {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const stopped = once(child, "exit");
      child.kill("SIGKILL");
      await stopped;
    }
    receiver.closeAllConnections();
    await new Promise<void>((resolve) =>
      receiver.close(() => {
        resolve();
      }),
    );
    await ctx.cleanup();
  }
}

describe("webhook scheduling after an ordinary process crash", () => {
  it(
    "delivers the committed event after SIGKILL between append and scheduling",
    () => crashWitness(false),
    30_000,
  );
  it(
    "resumes partial fan-out after SIGKILL without repeating its committed page",
    () => crashWitness(true),
    30_000,
  );
});

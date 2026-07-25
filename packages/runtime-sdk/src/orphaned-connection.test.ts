/**
 * Orphaned-connection handling in the queue consumer.
 *
 * When the lease broker reports that a Connection no longer exists (or
 * is no longer active), the message is unprocessable and will stay
 * unprocessable forever. Retrying it burns attempts; the important part
 * is tearing down the thing that keeps producing it — the per-Connection
 * schedule alarm.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { consumeBatch, type ConsumerEnvironment } from "./queue-consumer.js";
import { registerScheduleHandler, _resetHandlers } from "./handlers.js";
import { createInMemoryStorage } from "./in-memory-storage.js";
import { ConnectionGoneError } from "./errors.js";
import type { QueueMessage, ScheduleMessage } from "./types.js";

interface TestMessage<T> {
  readonly body: T;
  readonly id: string;
  readonly timestamp: Date;
  attempts: number;
  ack(): void;
  retry(opts?: { delaySeconds?: number }): void;
  acked: boolean;
  retried: boolean;
}

function makeMsg<T extends QueueMessage>(
  body: T,
  attempts = 1,
): TestMessage<T> {
  const m: TestMessage<T> = {
    body,
    id: `msg_${Math.random().toString(36).slice(2, 10)}`,
    timestamp: new Date(),
    attempts,
    acked: false,
    retried: false,
    ack(): void {
      m.acked = true;
    },
    retry(): void {
      m.retried = true;
      m.attempts++;
    },
  };
  return m;
}

const SCHED = (): ScheduleMessage => ({
  kind: "schedule",
  integration_name: "demo",
  connection_id: "conn_gone",
  scheduled_for_ms: 1000,
});

function makeGoneEnv(disarmed: string[]): ConsumerEnvironment {
  const stores = new Map<string, ReturnType<typeof createInMemoryStorage>>();
  return {
    apiUrl: "http://localhost:0",
    integrationName: "demo",
    storageFor: (id) => {
      let s = stores.get(id);
      if (!s) {
        s = createInMemoryStorage();
        stores.set(id, s);
      }
      return s;
    },
    mintCredential: (id) =>
      Promise.reject(
        new ConnectionGoneError(`Connection ${id} not found`, 404),
      ),
    disarmSchedule: (id) => {
      disarmed.push(id);
      return Promise.resolve();
    },
    echo: { echo_ttl_seconds: 60 },
  };
}

describe("orphaned connection", () => {
  beforeEach(() => {
    _resetHandlers();
    registerScheduleHandler(() => Promise.resolve({ ok: true }));
  });

  it("disarms the schedule instead of retrying when the lease is gone", async () => {
    const disarmed: string[] = [];
    const env = makeGoneEnv(disarmed);
    const msg = makeMsg(SCHED());

    const outcome = await consumeBatch(env, [msg]);

    expect(msg.acked).toBe(true);
    expect(msg.retried).toBe(false);
    expect(outcome.retried).toBe(0);
    expect(disarmed).toEqual(["conn_gone"]);
  });

  it("does not retry an orphan even on the first attempt", async () => {
    const disarmed: string[] = [];
    const env = makeGoneEnv(disarmed);
    const msg = makeMsg(SCHED(), 1);

    await consumeBatch(env, [msg]);

    // A first-attempt throw normally earns one retry. A gone connection
    // is terminal by definition, so the retry ladder must not engage.
    expect(msg.retried).toBe(false);
    expect(msg.acked).toBe(true);
  });

  it("still acks when no disarm hook is wired", async () => {
    const env = makeGoneEnv([]);
    delete (env as { disarmSchedule?: unknown }).disarmSchedule;
    const msg = makeMsg(SCHED());

    const outcome = await consumeBatch(env, [msg]);

    expect(msg.acked).toBe(true);
    expect(outcome.retried).toBe(0);
  });

  it("survives a disarm hook that throws", async () => {
    const env = makeGoneEnv([]);
    env.disarmSchedule = () => Promise.reject(new Error("DO unreachable"));
    const msg = makeMsg(SCHED());

    await expect(consumeBatch(env, [msg])).resolves.toBeDefined();
    expect(msg.acked).toBe(true);
  });
});

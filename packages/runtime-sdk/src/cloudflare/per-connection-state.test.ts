/**
 * Durable Object alarm lifecycle — arm, disarm, and the orphan
 * self-limit.
 *
 * The DO is exercised against a hand-rolled `DurableObjectState` double
 * rather than Miniflare, matching the package convention that every
 * test runs under plain Node. The double records `setAlarm` /
 * `deleteAlarm` calls so the tests can assert on alarm state directly.
 */
import { describe, it, expect } from "vitest";
import { PerConnectionState } from "./per-connection-state.js";
import type { PerConnectionAlarmEnv } from "./per-connection-state.js";
import { createInMemoryStorage } from "../in-memory-storage.js";
import type { ScheduleMessage } from "../types.js";

interface FakeState {
  state: DurableObjectState;
  alarms: (number | null)[];
  currentAlarm: () => number | null;
}

function fakeDurableObjectState(connectionId: string): FakeState {
  const backing = createInMemoryStorage();
  let alarm: number | null = null;
  const alarms: (number | null)[] = [];
  const storage = {
    get: (key: string) => backing.get(key),
    put: (key: string, value: unknown) => backing.put(key, value),
    delete: (key: string) => backing.delete(key),
    list: (options?: { prefix?: string; limit?: number }) =>
      backing.list(options),
    setAlarm: (at: number) => {
      alarm = at;
      alarms.push(at);
      return Promise.resolve();
    },
    deleteAlarm: () => {
      alarm = null;
      alarms.push(null);
      return Promise.resolve();
    },
    getAlarm: () => Promise.resolve(alarm),
  };
  return {
    state: {
      storage,
      id: { name: connectionId, toString: () => connectionId },
    } as unknown as DurableObjectState,
    alarms,
    currentAlarm: () => alarm,
  };
}

function envWithQueue(sent: ScheduleMessage[]): PerConnectionAlarmEnv {
  return {
    INTEGRATION_NAME: "withmarfa.rss-watcher",
    MANIFEST_CRON: "0 * * * *",
    SCHEDULED_POLL_QUEUE: {
      send: (message: ScheduleMessage) => {
        sent.push(message);
        return Promise.resolve();
      },
    } as unknown as Queue<ScheduleMessage>,
  };
}

describe("PerConnectionState alarm lifecycle", () => {
  it("arms an alarm and re-arms on every fire", async () => {
    const fake = fakeDurableObjectState("conn_a");
    const sent: ScheduleMessage[] = [];
    const doInstance = new PerConnectionState(fake.state, envWithQueue(sent));

    const armed = await doInstance.armSchedule();
    expect(armed).toBeTypeOf("number");
    expect(fake.currentAlarm()).toBe(armed);

    await doInstance.alarm();
    expect(sent).toHaveLength(1);
    expect(fake.currentAlarm()).toBeTypeOf("number");
  });

  it("disarms the alarm and reports the cancelled target", async () => {
    const fake = fakeDurableObjectState("conn_b");
    const sent: ScheduleMessage[] = [];
    const doInstance = new PerConnectionState(fake.state, envWithQueue(sent));

    const armed = await doInstance.armSchedule();
    const result = await doInstance.disarmSchedule("uninstall");

    expect(result.disarmed).toBe(true);
    expect(result.previous_next_run_at_ms).toBe(armed);
    expect(fake.currentAlarm()).toBeNull();
  });

  it("treats disarming a never-armed schedule as success", async () => {
    const fake = fakeDurableObjectState("conn_c");
    const doInstance = new PerConnectionState(fake.state, envWithQueue([]));

    const result = await doInstance.disarmSchedule("uninstall");

    expect(result.disarmed).toBe(true);
    expect(result.previous_next_run_at_ms).toBeNull();
    expect(fake.currentAlarm()).toBeNull();
  });

  it("treats a repeated disarm as success", async () => {
    const fake = fakeDurableObjectState("conn_d");
    const doInstance = new PerConnectionState(fake.state, envWithQueue([]));

    await doInstance.armSchedule();
    await doInstance.disarmSchedule("uninstall");
    const second = await doInstance.disarmSchedule("uninstall");

    expect(second.disarmed).toBe(true);
    expect(fake.currentAlarm()).toBeNull();
  });

  it("neither enqueues nor re-arms once disarmed", async () => {
    const fake = fakeDurableObjectState("conn_e");
    const sent: ScheduleMessage[] = [];
    const doInstance = new PerConnectionState(fake.state, envWithQueue(sent));

    await doInstance.armSchedule();
    await doInstance.disarmSchedule("connection_gone");

    // An alarm that fires after the disarm has fully landed reads the
    // tombstone first and stops there. This is the ordinary case; the
    // mid-flight interleaving is covered separately below.
    await doInstance.alarm();

    expect(sent).toHaveLength(0);
    expect(fake.currentAlarm()).toBeNull();
  });

  it("does not re-arm when a disarm lands mid-tick, during the queue send", async () => {
    const fake = fakeDurableObjectState("conn_e2");
    const sent: ScheduleMessage[] = [];
    // Awaiting the queue send opens the Durable Object's input gate, so
    // an inbound disarm can be delivered while `alarm()` is suspended
    // there. Reading the tombstone only at the top of `alarm()` misses
    // it, and the re-arm at the end resurrects the schedule the disarm
    // just tore down. Driving the disarm from inside `send` reproduces
    // exactly that interleaving. The holder breaks the cycle between the
    // env (which the DO needs) and the DO (which `send` needs).
    const holder: { instance?: PerConnectionState } = {};
    const env: PerConnectionAlarmEnv = {
      INTEGRATION_NAME: "withmarfa.rss-watcher",
      MANIFEST_CRON: "0 * * * *",
      SCHEDULED_POLL_QUEUE: {
        send: async (message: ScheduleMessage) => {
          sent.push(message);
          await holder.instance?.disarmSchedule("uninstall");
        },
      } as unknown as Queue<ScheduleMessage>,
    };
    const doInstance = new PerConnectionState(fake.state, env);
    holder.instance = doInstance;

    await doInstance.armSchedule();
    await doInstance.alarm();

    // One already-sent message is the accepted cost — it was in flight
    // before the disarm arrived, and the consumer drops it when the
    // lease fails. What must not survive is the alarm itself.
    expect(sent).toHaveLength(1);
    expect(fake.currentAlarm()).toBeNull();
  });

  it("re-arming after a disarm clears the tombstone", async () => {
    const fake = fakeDurableObjectState("conn_f");
    const sent: ScheduleMessage[] = [];
    const doInstance = new PerConnectionState(fake.state, envWithQueue(sent));

    await doInstance.armSchedule();
    await doInstance.disarmSchedule("connection_gone");
    const rearmed = await doInstance.armSchedule();

    expect(rearmed).toBeTypeOf("number");
    await doInstance.alarm();
    expect(sent).toHaveLength(1);
    expect(fake.currentAlarm()).toBeTypeOf("number");
  });

  it("exposes disarm over the DO fetch surface", async () => {
    const fake = fakeDurableObjectState("conn_g");
    const doInstance = new PerConnectionState(fake.state, envWithQueue([]));
    await doInstance.armSchedule();

    const res = await doInstance.fetch(
      new Request("https://do.invalid/disarm-schedule", { method: "POST" }),
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; disarmed: boolean }>();
    expect(body.ok).toBe(true);
    expect(body.disarmed).toBe(true);
    expect(fake.currentAlarm()).toBeNull();
  });
});

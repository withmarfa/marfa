import { describe, it, expect } from "vitest";
import {
  buildConsumerEnv,
  type IntegrationWorkerEnv,
  type IntegrationWorkerConfig,
} from "./worker-entry.js";
import type { DlqProducer } from "./queue-consumer.js";

/**
 * Routing tests for `buildConsumerEnv` (T-103). The wrapper's own
 * tests in `queue-consumer.test.ts` mock `dlqProducerFor` directly,
 * which doesn't exercise the env→consumer wiring: a swap in the
 * worker-entry switch (e.g. webhook → SCHEDULED_POLL) would still
 * pass those tests but route DLQ messages to the wrong queue at
 * runtime. These tests pin the kind → binding map.
 */

function makeProducer(label: string): DlqProducer & { _label: string } {
  return {
    _label: label,
    send: () => Promise.resolve(),
  };
}

function makeBaseEnv(): IntegrationWorkerEnv {
  // Cast only the DO binding — we don't exercise that path here, just
  // dlqProducerFor wiring.
  return {
    PER_CONNECTION_STATE: {} as IntegrationWorkerEnv["PER_CONNECTION_STATE"],
    INTEGRATION_NAME: "demo",
    MYME_API_URL: "https://server.invalid",
    MYME_RUNTIME_CONTROL_URL: "https://control.invalid",
    MYME_RUNTIME_BROKER_KEY: "broker_key",
  };
}

const CONFIG: IntegrationWorkerConfig = {
  integrationName: "demo",
  echo: { echo_ttl_seconds: 60 },
};

describe("buildConsumerEnv.dlqProducerFor (T-103 routing)", () => {
  it("routes webhook → WEBHOOK_RECEIPT_DLQ_QUEUE", () => {
    const wh = makeProducer("webhook");
    const env = { ...makeBaseEnv(), WEBHOOK_RECEIPT_DLQ_QUEUE: wh };
    const consumer = buildConsumerEnv(env, CONFIG);
    expect(consumer.dlqProducerFor?.("webhook")).toBe(wh);
    expect(consumer.dlqProducerFor?.("schedule")).toBeNull();
    expect(consumer.dlqProducerFor?.("item-event")).toBeNull();
  });

  it("routes schedule → SCHEDULED_POLL_DLQ_QUEUE", () => {
    const sp = makeProducer("schedule");
    const env = { ...makeBaseEnv(), SCHEDULED_POLL_DLQ_QUEUE: sp };
    const consumer = buildConsumerEnv(env, CONFIG);
    expect(consumer.dlqProducerFor?.("schedule")).toBe(sp);
    expect(consumer.dlqProducerFor?.("webhook")).toBeNull();
    expect(consumer.dlqProducerFor?.("item-event")).toBeNull();
  });

  it("routes item-event → REACTIVE_RUN_DLQ_QUEUE", () => {
    const rr = makeProducer("item-event");
    const env = { ...makeBaseEnv(), REACTIVE_RUN_DLQ_QUEUE: rr };
    const consumer = buildConsumerEnv(env, CONFIG);
    expect(consumer.dlqProducerFor?.("item-event")).toBe(rr);
    expect(consumer.dlqProducerFor?.("webhook")).toBeNull();
    expect(consumer.dlqProducerFor?.("schedule")).toBeNull();
  });

  it("returns null for every kind when no DLQ bindings are wired", () => {
    const consumer = buildConsumerEnv(makeBaseEnv(), CONFIG);
    expect(consumer.dlqProducerFor?.("webhook")).toBeNull();
    expect(consumer.dlqProducerFor?.("schedule")).toBeNull();
    expect(consumer.dlqProducerFor?.("item-event")).toBeNull();
  });

  it("returns each producer independently when all three are wired (multi-family Worker)", () => {
    // task-auto-archive shape: consumes both scheduled-poll and
    // reactive-run, so it wires two DLQ producers. Verify they don't
    // collapse to one.
    const sp = makeProducer("schedule");
    const rr = makeProducer("item-event");
    const wh = makeProducer("webhook");
    const env = {
      ...makeBaseEnv(),
      SCHEDULED_POLL_DLQ_QUEUE: sp,
      REACTIVE_RUN_DLQ_QUEUE: rr,
      WEBHOOK_RECEIPT_DLQ_QUEUE: wh,
    };
    const consumer = buildConsumerEnv(env, CONFIG);
    expect(consumer.dlqProducerFor?.("schedule")).toBe(sp);
    expect(consumer.dlqProducerFor?.("item-event")).toBe(rr);
    expect(consumer.dlqProducerFor?.("webhook")).toBe(wh);
  });
});

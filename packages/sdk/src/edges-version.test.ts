import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createBootstrappedFixture,
  type BootstrappedFixture,
} from "./test-harness.js";
import { EdgeConflictError } from "./errors.js";

/**
 * `client.edges.update` against a real in-process server, because what is
 * being checked is whether the precondition reaches the database and
 * whether the refusal survives the transport.
 *
 * Both halves have a failure mode worth a fixture. A version dropped on the
 * way out no longer passes silently — the door refuses it — but the refusal
 * it draws is `missing_required_field`, which reads as the caller's own bug
 * rather than as a client that lost the precondition, so nothing about the
 * symptom points at the kit. A 409
 * that surfaces as the transport's generic error is worse than useless
 * here: it says the write failed and discards the current edge, which is
 * the only thing in the body and the cheapest route back to a version worth
 * retrying with — `GET /edges/{id}` is the other, and paying for it is the
 * cost of losing this.
 */

let fx: BootstrappedFixture;

beforeAll(async () => {
  fx = await createBootstrappedFixture();
});

afterAll(() => {
  fx.cleanup();
});

async function edge(properties: Record<string, unknown>) {
  const source = await fx.client.items.create({
    type: "core.note",
    properties: { body: "source" },
  });
  const target = await fx.client.items.create({
    type: "core.note",
    properties: { body: "target" },
  });
  return fx.client.edges.create({
    source_id: source.id,
    target_id: target.id,
    edge_type: "references",
    properties,
  });
}

describe("edges.update", () => {
  it("sends the version it was given, so a stale write is refused", async () => {
    const created = await edge({ note: "base" });
    expect(created.version).toBe(1);

    const winner = await fx.client.edges.update(
      created.id,
      { note: "winner" },
      { version: 1 },
    );
    expect(winner.version).toBe(2);

    await expect(
      fx.client.edges.update(created.id, { note: "loser" }, { version: 1 }),
    ).rejects.toBeInstanceOf(EdgeConflictError);
  });

  it("carries the current edge on the refusal, so the caller can re-apply", async () => {
    const created = await edge({ note: "base" });
    await fx.client.edges.update(
      created.id,
      { note: "winner" },
      { version: created.version },
    );

    const refusal = await fx.client.edges
      .update(created.id, { note: "loser" }, { version: 1 })
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(refusal).toBeInstanceOf(EdgeConflictError);
    const conflict = refusal as EdgeConflictError;
    expect(conflict.current.id).toBe(created.id);
    expect(conflict.current.version).toBe(2);
    expect(conflict.current.properties).toEqual({ note: "winner" });

    // The documented resolution, end to end: edges have no merge policy, so
    // the caller re-applies over what came back and sends that version.
    const resolved = await fx.client.edges.update(
      created.id,
      { ...conflict.current.properties, note: "re-applied" },
      { version: conflict.current.version },
    );
    expect(resolved.version).toBe(3);
    expect(resolved.properties).toEqual({ note: "re-applied" });
  });
});

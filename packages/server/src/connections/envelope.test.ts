/**
 * The reactive bridge's per-subscriber dispatch gate.
 *
 * `evaluateDispatch` is shared by the bridge's fanout and
 * `POST /connections/preview-event`, so what it decides is what both
 * do. It had no direct coverage until a routine import walked two
 * integrations into the cycle hop ceiling.
 */
import { describe, it, expect } from "vitest";
import { evaluateDispatch, type SubscriptionEntry } from "./envelope.js";
import type { ItemEventWithId } from "../pubsub.js";

const SUBSCRIBER: SubscriptionEntry = {
  connection_id: "conn_subscriber",
  integration_name: "example.integration",
  space_id: "space_1",
  target_types: ["core.note", "example.document"],
};

function event(
  over: Partial<{
    type: string;
    itemType: string;
    originatingConnectionId: string | null;
    spaceId: string | null;
  }> = {},
): ItemEventWithId {
  return {
    type: over.type ?? "created",
    item: {
      id: "item_1",
      type: over.itemType ?? "core.note",
    },
    spaceId: over.spaceId === undefined ? "space_1" : over.spaceId,
    originatingConnectionId:
      over.originatingConnectionId === undefined
        ? "conn_other"
        : over.originatingConnectionId,
  } as unknown as ItemEventWithId;
}

describe("evaluateDispatch", () => {
  it("dispatches an ordinary item event from another connection", () => {
    expect(evaluateDispatch(event(), SUBSCRIBER)).toEqual({
      would_dispatch: true,
    });
  });

  it("never dispatches the platform's own bookkeeping", () => {
    // Reporting progress is itself an item event. Without this gate two
    // reactive connections in one space answer each other's activity
    // rows, the cycle hop counter climbs, and at budget real events
    // start being dropped — which an ordinary import was enough to do.
    for (const itemType of [
      "system.activity",
      "system.connection",
      "system.credential",
      "system.integration",
    ]) {
      expect(evaluateDispatch(event({ itemType }), SUBSCRIBER)).toEqual({
        would_dispatch: false,
        reason: "system_type",
      });
    }
  });

  it("still dispatches a type that merely starts with the same letters", () => {
    expect(
      evaluateDispatch(event({ itemType: "systemic.note" }), {
        ...SUBSCRIBER,
        target_types: ["systemic.note"],
      }),
    ).toEqual({ would_dispatch: true });
  });

  it("does not dispatch a connection its own event", () => {
    expect(
      evaluateDispatch(
        event({ originatingConnectionId: SUBSCRIBER.connection_id }),
        SUBSCRIBER,
      ),
    ).toEqual({ would_dispatch: false, reason: "self_event" });
  });

  it("does not dispatch across spaces", () => {
    expect(evaluateDispatch(event({ spaceId: "space_2" }), SUBSCRIBER)).toEqual(
      { would_dispatch: false, reason: "cross_space" },
    );
  });

  it("gates on the system type before anything else", () => {
    // A system row is not dispatched even when every other gate would
    // have passed it, and the reason names the actual cause.
    expect(
      evaluateDispatch(
        event({ itemType: "system.activity", spaceId: "space_2" }),
        SUBSCRIBER,
      ),
    ).toEqual({ would_dispatch: false, reason: "system_type" });
  });

  it("passes an instance-wide row where neither side carries a space", () => {
    expect(
      evaluateDispatch(event({ spaceId: null }), {
        ...SUBSCRIBER,
        space_id: null,
      }),
    ).toEqual({ would_dispatch: true });
  });

  it("does not dispatch a type the subscriber's manifest never declares", () => {
    // The subscriber's runtime credential is minted to exactly its
    // manifest's types, so this dispatch could only fail in the handler
    // — as a 403 the moment it reads the item back.
    expect(
      evaluateDispatch(event({ itemType: "other.podcast" }), SUBSCRIBER),
    ).toEqual({ would_dispatch: false, reason: "type_not_targeted" });
  });

  it("dispatches every type the manifest declares, not just the first", () => {
    expect(
      evaluateDispatch(event({ itemType: "example.document" }), SUBSCRIBER),
    ).toEqual({ would_dispatch: true });
  });

  it("keeps the more specific reason when several gates refuse", () => {
    // An undeclared type from the subscriber's own event still reads
    // self_event: the type gate runs last so existing reasons hold.
    expect(
      evaluateDispatch(
        event({
          itemType: "other.podcast",
          originatingConnectionId: SUBSCRIBER.connection_id,
        }),
        SUBSCRIBER,
      ),
    ).toEqual({ would_dispatch: false, reason: "self_event" });
  });
});

import { describe, it, expect, vi } from "vitest";
import { ConnectionStateManager } from "./connection-state.js";
import type { ConnectionState } from "./connection-state.js";

describe("ConnectionStateManager", () => {
  it("starts in disconnected state", () => {
    const mgr = new ConnectionStateManager();
    expect(mgr.current).toBe("disconnected");
  });

  it("transitions through valid states", () => {
    const mgr = new ConnectionStateManager();
    mgr.transition("connecting");
    expect(mgr.current).toBe("connecting");

    mgr.transition("syncing");
    expect(mgr.current).toBe("syncing");

    mgr.transition("connected");
    expect(mgr.current).toBe("connected");
  });

  it("notifies subscribers on transition", () => {
    const mgr = new ConnectionStateManager();
    const states: ConnectionState[] = [];
    mgr.subscribe((state) => states.push(state));

    mgr.transition("connecting");
    mgr.transition("syncing");
    mgr.transition("connected");

    expect(states).toEqual(["connecting", "syncing", "connected"]);
  });

  it("unsubscribe removes listener", () => {
    const mgr = new ConnectionStateManager();
    const states: ConnectionState[] = [];
    const unsub = mgr.subscribe((state) => states.push(state));

    mgr.transition("connecting");
    unsub();
    mgr.transition("syncing");

    expect(states).toEqual(["connecting"]);
  });

  it("handles error state with error object", () => {
    const mgr = new ConnectionStateManager();
    mgr.transition("connecting");
    const err = new Error("Connection lost");
    mgr.transition("error", err);

    expect(mgr.current).toBe("error");
    expect(mgr.error).toBe(err);
  });

  it("warns on unexpected transitions but still applies", () => {
    const mgr = new ConnectionStateManager();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // disconnected → connected is not in the valid list
    mgr.transition("connected");

    expect(spy).toHaveBeenCalled();
    expect(mgr.current).toBe("connected");

    spy.mockRestore();
  });

  it("recovers from error to connecting", () => {
    const mgr = new ConnectionStateManager();
    mgr.transition("connecting");
    mgr.transition("error", new Error("fail"));
    mgr.transition("connecting");

    expect(mgr.current).toBe("connecting");
    expect(mgr.error).toBeUndefined();
  });
});

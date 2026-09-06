import { describe, expect, it } from "vitest";
import { liveConnectionRefusal } from "./_connection-refusal.js";

const row = (properties: Record<string, unknown>) => ({
  id: "01a0",
  type: "system.connection",
  properties,
});

describe("liveConnectionRefusal", () => {
  it("names the grant routes for a live app and the uninstall route for a live integration", () => {
    expect(
      liveConnectionRefusal(row({ kind: "app", status: "active" })),
    ).toContain("DELETE /auth/grants/01a0");
    expect(
      liveConnectionRefusal(row({ kind: "integration", status: "active" })),
    ).toContain("POST /connections/01a0/uninstall");
  });

  it("lets a revoked connection of either kind go, and anything that is not a connection", () => {
    expect(
      liveConnectionRefusal(row({ kind: "app", status: "revoked" })),
    ).toBeUndefined();
    expect(
      liveConnectionRefusal(row({ kind: "integration", status: "revoked" })),
    ).toBeUndefined();
    expect(
      liveConnectionRefusal({
        id: "x",
        type: "core.note",
        properties: { status: "active" },
      }),
    ).toBeUndefined();
    expect(liveConnectionRefusal(null)).toBeUndefined();
  });

  it("fails closed on a status that is not revoked and on a kind it does not know", () => {
    expect(liveConnectionRefusal(row({ kind: "app" }))).toContain("still live");
    expect(
      liveConnectionRefusal(row({ kind: "app", status: "paused" })),
    ).toContain("still live");
    const unknown = liveConnectionRefusal(
      row({ kind: "mystery", status: "active" }),
    );
    expect(unknown).toContain("no recognized kind");
    expect(unknown).toContain("administrative repair");
    expect(
      liveConnectionRefusal(row({ kind: "mystery", status: "revoked" })),
    ).toBeUndefined();
  });
});

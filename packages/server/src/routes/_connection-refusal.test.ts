import { describe, expect, it } from "vitest";
import { liveConnectionRefusal } from "./_connection-refusal.js";

const row = (properties: Record<string, unknown>) => ({
  id: "01a0",
  type: "system.connection",
  properties,
});

describe("liveConnectionRefusal", () => {
  it("names a route for a live app, and no route at all for a live connector", () => {
    // The app arm names a door that exists. The connector arm used to name
    // `POST /connections/{id}/uninstall` and promise it would revoke leased
    // tokens, drop cached upstream tokens and disable inbound webhooks —
    // one route and three subsystems, none of which survived the rip-out.
    // This assertion is the reason that sentence stood: it pinned the route
    // by name, so the refusal read as maintained.
    expect(
      liveConnectionRefusal(row({ kind: "app", status: "active" })),
    ).toContain("DELETE /auth/grants/01a0");

    const connector = liveConnectionRefusal(
      row({ kind: "connector", status: "active" }),
    );
    expect(connector).toContain("still live");
    expect(connector).not.toMatch(/\/connections\//);
  });

  it("lets a revoked connection of either kind go, and anything that is not a connection", () => {
    expect(
      liveConnectionRefusal(row({ kind: "app", status: "revoked" })),
    ).toBeUndefined();
    expect(
      liveConnectionRefusal(row({ kind: "connector", status: "revoked" })),
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

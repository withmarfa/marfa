import { afterEach, expect, it, vi } from "vitest";
import { authenticateOwner } from "../client/owner-session.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([0, 120_000])(
  "checks freshness after a lookup taking %i ms",
  async (delay) => {
    vi.useFakeTimers();
    const start = Date.parse("2026-01-01T12:00:00Z");
    vi.setSystemTime(start);
    const request = vi.fn(async (url: string) => {
      if (url.endsWith("/get-session")) {
        vi.setSystemTime(start + delay);
        return Response.json({
          session: { createdAt: new Date(start - 239_000).toISOString() },
        });
      }
      return new Response(null, {
        headers: { "set-cookie": "marfa.auth.session_token=new; Path=/" },
      });
    });
    vi.stubGlobal("fetch", request);
    const session = await authenticateOwner("http://instance.test", "old", {
      email: "owner@example.test",
      password: "test-password",
    });
    expect(session.cookie).toBe(
      delay === 0 ? "old" : "marfa.auth.session_token=new",
    );
    expect(request).toHaveBeenCalledTimes(delay === 0 ? 1 : 2);
    expect(session.authenticatedAt).toBe(
      delay === 0 ? start - 239_000 : start + delay,
    );
  },
);

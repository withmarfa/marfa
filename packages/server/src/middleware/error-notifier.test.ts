import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// notifyError — the debounce and the sweep that bounds it
// ---------------------------------------------------------------------------

/**
 * The debounce map is module state, so each case takes a fresh copy of the
 * module rather than trying to empty the one the last case filled.
 */
async function freshNotifier(): Promise<typeof import("./error-notifier.js")> {
  vi.resetModules();
  return import("./error-notifier.js");
}

const WEBHOOK = "https://example.invalid/hook";

function notification(error: string, path: string) {
  return {
    timestamp: new Date().toISOString(),
    request_id: "019d1234-5678-7abc-8def-1234567890ab",
    error,
    path,
    method: "GET",
  };
}

describe("the error webhook's debounce", () => {
  let sent: number;

  beforeEach(() => {
    sent = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.stubGlobal("fetch", () => {
      sent += 1;
      return Promise.resolve(new Response(null, { status: 204 }));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetModules();
  });

  it("sends the first of a repeated error and holds the rest inside the window", async () => {
    const { notifyError } = await freshNotifier();
    notifyError(WEBHOOK, notification("boom", "/a"));
    notifyError(WEBHOOK, notification("boom", "/a"));
    expect(sent).toBe(1);
  });

  it("drops the entries whose window has passed on the next send", async () => {
    const { notifyError, debounceEntryCount } = await freshNotifier();

    notifyError(WEBHOOK, notification("boom", "/a"));
    notifyError(WEBHOOK, notification("crash", "/b"));
    // The witness: both entries are really in the map, so the count below
    // is a sweep clearing them rather than a map that never held them.
    expect(debounceEntryCount()).toBe(2);

    // Past the window, so neither entry can debounce anything any longer.
    vi.setSystemTime(new Date("2026-01-01T00:02:00Z"));
    notifyError(WEBHOOK, notification("later", "/c"));

    // Only the entry this send added. A sweep that walked the map without
    // deleting would leave three.
    expect(debounceEntryCount()).toBe(1);
    expect(sent).toBe(3);
  });

  it("keeps an entry the window still covers when a different error sweeps", async () => {
    const { notifyError, debounceEntryCount } = await freshNotifier();

    notifyError(WEBHOOK, notification("boom", "/a"));
    // Well inside the window the first entry was written in, so the sweep
    // this send runs has to leave it alone.
    vi.setSystemTime(new Date("2026-01-01T00:00:10Z"));
    notifyError(WEBHOOK, notification("crash", "/b"));

    expect(debounceEntryCount()).toBe(2);
  });
});

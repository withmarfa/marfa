import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { answers, refusal } from "../../device/marfa-answers.js";
import { BUILT_FOR, type Answer } from "../../device/scripted-server.js";
import {
  hydratedHarness,
  scriptHydration,
  scriptWrites,
  startHarness,
  type Harness,
} from "./harness.js";

/**
 * A device refuses a server older than the oldest release it works with, at
 * the server's root, before it asks for anything else.
 *
 * Scripted, because the server under test runs the release it was built as.
 * The oldest release is read off the constant the core holds, so the fixture
 * moves with it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const OLDEST = /OLDEST_SERVER: &str = "(\d+\.\d+\.\d+)"/.exec(
  readFileSync(
    join(here, "../../../../core/marfa-rules/src/release.rs"),
    "utf8",
  ),
)?.[1];
if (OLDEST === undefined) throw new Error("the core names no oldest server");

/** The release before `release`, with the last number one lower. */
function before(release: string): string {
  const [major, minor, patch] = release.split(".").map(Number) as [
    number,
    number,
    number,
  ];
  if (patch === 0) throw new Error(`no release before ${release}`);
  return `${major}.${minor}.${patch - 1}`;
}

/** The release after `release`, with the last number one higher. */
function after(release: string): string {
  const [major, minor, patch] = release.split(".").map(Number) as [
    number,
    number,
    number,
  ];
  return `${major}.${minor}.${patch + 1}`;
}

/** The root of a server running `version`, written as the root writes it. */
function running(version: unknown): Answer {
  const root = answers.root(Number(BUILT_FOR));
  if (root.kind !== "json") throw new Error("the root is not JSON");
  return {
    ...root,
    body: { ...(root.body as Record<string, unknown>), version },
  };
}

const sent = (harness: Harness) =>
  harness.server.requests.map((r) => `${r.method} ${r.pathname}`);

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe("a server older than the oldest release a device works with", () => {
  it("refuses a hydration at the root, holding nothing and sending nothing else", async () => {
    harness = await startHarness("oldest-server-hydrate");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      items: { "core.note": [{ item: { id: "n1" } }] },
    });
    // Queued in the order the root is asked: the last answer then stays.
    server.answer("GET", "/", running(before(OLDEST!)), running(OLDEST));
    const refused = await device.hydrate(["core.note"], "library");
    expect(refused.ok, "a copy hydrated from a server that is too old").toBe(
      false,
    );
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("server_too_old");
      expect(refused.refusal.raw).toContain(before(OLDEST!));
      expect(refused.refusal.raw).toContain(OLDEST!);
    }
    expect(sent(harness)).toEqual(["GET /"]);
    const status = await device.status();
    expect(status.ok && status.value.hydration).toBe("never");

    // The witness: the same script on the oldest release hydrates, and the
    // item is held.
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect((await device.get("n1")).ok).toBe(true);
  });

  it("refuses a catch-up at the root, leaving the cursor where it was", async () => {
    harness = await hydratedHarness("oldest-server-catch-up", { head: "10" });
    const { server, device } = harness;
    const held = await device.status();
    const requests = server.requests.length;
    server.answer("GET", "/", running(before(OLDEST!)), running(OLDEST));
    const refused = await device.catchUp();
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("server_too_old");
      expect(refused.refusal.raw).toContain(before(OLDEST!));
      expect(refused.refusal.raw).toContain(OLDEST!);
    }
    expect(sent(harness).slice(requests)).toEqual(["GET /"]);
    const status = await device.status();
    expect(status.ok && held.ok && status.value.event_cursor).toBe(
      held.ok ? held.value.event_cursor : undefined,
    );

    // The witness: the oldest release is caught up with.
    expect((await device.catchUp()).ok).toBe(true);
  });

  it("refuses a drain at the root, leaving the write queued and unsent", async () => {
    harness = await hydratedHarness("oldest-server-drain", { head: "10" });
    const { server, device } = harness;
    const queued = await device.create({
      type: "core.note",
      properties: { title: "Waits for a newer server" },
    });
    expect(queued.ok).toBe(true);
    scriptWrites(server, {
      create: [
        refusal(403, "forbidden", "This credential may not write here.", {}),
      ],
    });
    expect((await device.drain()).ok).toBe(true);
    const held = await device.queue();
    expect(held.ok && held.value.map((row) => [row.verdict, row.reason])).toEqual(
      [["blocked", "credential_refused"]],
    );
    const requests = server.requests.length;
    server.answer("GET", "/", running(before(OLDEST!)));
    const refused = await device.drain();
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("server_too_old");
      expect(refused.refusal.raw).toContain(before(OLDEST!));
      expect(refused.refusal.raw).toContain(OLDEST!);
    }
    expect(sent(harness).slice(requests)).toEqual(["GET /"]);
    const queue = await device.queue();
    expect(queue.ok && held.ok && queue.value).toEqual(held.ok && held.value);
  });
});

describe("a server at or past the oldest release, or one whose release cannot be judged", () => {
  const unjudged = [
    ["development build", "dev"],
    ["unstamped build", "0.0.0"],
    ["not three numbers", "0.0"],
    ["words", "banana"],
    ["a number", 74],
    ["nothing", null],
  ] as const;
  const allowed = (): ReadonlyArray<readonly [string, unknown]> => [
    ["the oldest release", OLDEST],
    ["a newer release", after(OLDEST!)],
    ["a newer minor", "0.1.0"],
    ...unjudged,
  ];

  it("is hydrated from, whether the release is the oldest, newer or unjudged", async () => {
    for (const [what, version] of allowed()) {
      harness = await startHarness("oldest-server-allowed");
      const { server, device } = harness;
      scriptHydration(server, {
        head: "10",
        items: { "core.note": [{ item: { id: "n1" } }] },
      });
      server.answer("GET", "/", running(version));
      const hydrated = await device.hydrate(["core.note"], "library");
      expect(hydrated.ok, `${what}: ${JSON.stringify(hydrated)}`).toBe(true);
      expect((await device.get("n1")).ok, what).toBe(true);
      await harness.stop();
      harness = undefined;
    }
  });
});

describe("a root that names no release", () => {
  it("is hydrated from, though its root names no release", async () => {
    harness = await startHarness("oldest-server-unnamed");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    const root = answers.root(Number(BUILT_FOR));
    if (root.kind !== "json") throw new Error("the root is not JSON");
    const { version: _named, ...body } = root.body as Record<string, unknown>;
    server.answer("GET", "/", { ...root, body });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { refusal } from "../../device/marfa-answers.js";
import type { Outcome } from "../../device/protocol.js";
import type { ScriptedServer } from "../../device/scripted-server.js";
import {
  scriptHydration,
  startBindingHarness,
  startHarness,
} from "./harness.js";

interface Door {
  hydrate: (types: string[]) => Promise<Outcome<unknown>>;
}
interface Opened {
  server: ScriptedServer;
  door: Door;
  stop: () => Promise<void>;
}

const doors: Array<{ name: string; open: (label: string) => Promise<Opened> }> =
  [
    {
      name: "the command line",
      open: async (label) => {
        const started = await startHarness(label);
        return {
          server: started.server,
          door: {
            hydrate: (types) => started.device.hydrate(types, "library"),
          },
          stop: started.stop,
        };
      },
    },
    {
      name: "the binding",
      open: async (label) => {
        const started = await startBindingHarness(label);
        return {
          server: started.server,
          door: {
            hydrate: async (types) =>
              await started.device.hydrate(types, "library"),
          },
          stop: started.stop,
        };
      },
    },
  ];

let opened: Opened | undefined;

afterEach(async () => {
  await opened?.stop();
  opened = undefined;
});

describe.each(doors)("through $name", ({ name, open }) => {
  it("names the answer behind a copy a hydration expired, with the details the server sent", async () => {
    opened = await open(`refusal-answers-ended-${name.length}`);
    scriptHydration(opened.server, {
      head: "10",
      replay: () =>
        refusal(401, "unauthorized", "The key has ended", { ended: "revoked" }),
    });
    const ended = await opened.door.hydrate(["core.note"]);
    expect(ended.ok, "a credential the server ended did not refuse").toBe(
      false,
    );
    if (ended.ok) return;
    expect(ended.refusal.code).toBe("copy_expired");
    expect(ended.refusal.server, ended.refusal.raw).toEqual({
      status: 401,
      code: "unauthorized",
      details: { ended: "revoked" },
    });
  });

  it("names the answer a server gave a refused read of its types", async () => {
    opened = await open(`refusal-answers-types-${name.length}`);
    scriptHydration(opened.server, {
      head: "10",
      catalog: () =>
        refusal(403, "type_not_permitted", "No read access", {
          grant: { kind: "type", name: "core.note", level: "read" },
        }),
    });
    const refused = await opened.door.hydrate(["core.note"]);
    expect(refused.ok, "a catalog the server refused was read").toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.server?.status, refused.refusal.raw).toBe(403);
    expect(refused.refusal.server?.code).toBe("type_not_permitted");
    expect(refused.refusal.server?.details).toEqual({
      grant: { kind: "type", name: "core.note", level: "read" },
    });
  });

  it("carries no server answer on a refusal the copy made without asking", async () => {
    opened = await open(`refusal-answers-local-${name.length}`);
    scriptHydration(opened.server, { head: "10" });
    // The witness: the same call, naming a type the server holds, is not refused.
    const held = await opened.door.hydrate(["core.note"]);
    expect(held.ok, JSON.stringify(held)).toBe(true);
    const refused = await opened.door.hydrate(["nope.thing"]);
    expect(refused.ok, "a type no server holds was hydrated").toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code).toBe("unknown_type");
    expect(refused.refusal.server, refused.refusal.raw).toBeNull();
  });
});

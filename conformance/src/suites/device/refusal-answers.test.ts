import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliFolder } from "../../device/cli-adapter.js";
import { refusal } from "../../device/marfa-answers.js";
import type { Outcome } from "../../device/protocol.js";
import type { ScriptedServer } from "../../device/scripted-server.js";
import {
  KEY,
  requireBinary,
  scriptHydration,
  startBindingHarness,
  startHarness,
} from "./harness.js";

interface Door {
  hydrate: (types: string[]) => Promise<Outcome<unknown>>;
  /** Adds the directory `dir` as a copy of the folder `id`. */
  addFolder: (dir: string, id: string) => Promise<Outcome<unknown>>;
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
            addFolder: (dir, id) =>
              new CliFolder(dir, {
                binary: requireBinary(),
                url: started.server.url,
                key: KEY,
                registry: join(dir, "..", "registry", "folders.json"),
              }).add(id),
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
            addFolder: async (dir, id) =>
              await started.device.folder(dir).add(id),
          },
          stop: started.stop,
        };
      },
    },
  ];

let opened: Opened | undefined;
let scratch: string | undefined;

afterEach(async () => {
  await opened?.stop();
  opened = undefined;
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
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

  it("names the answer a server gave for a folder it does not hold, where a folder is added", async () => {
    opened = await open(`refusal-answers-folder-${name.length}`);
    const folder = "01a00000-0000-7000-8000-00000000f01d";
    // A credential that is not a key, whose own map the add cannot read.
    opened.server.answer(
      "GET",
      "/keys/current",
      refusal(403, "forbidden", "Not a key"),
    );
    opened.server.answer(
      "GET",
      `/items/${folder}`,
      refusal(404, "item_not_found", "No such item", { id: folder }),
    );
    scratch = mkdtempSync(join(realpathSync(tmpdir()), "marfa-refusal-"));
    const added = await opened.door.addFolder(join(scratch, "notes"), folder);
    expect(added.ok, "a folder the server does not hold was added").toBe(false);
    if (added.ok) return;
    expect(added.refusal.code).toBe("not_found");
    expect(added.refusal.server, added.refusal.raw).toEqual({
      status: 404,
      code: "item_not_found",
      details: { id: folder },
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

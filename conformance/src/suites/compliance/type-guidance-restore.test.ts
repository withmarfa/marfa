import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { editLineFile } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * Guidance and descriptions go through an export and a restore. A type stored
 * over a limit can be held only by an archive that says so, so the fixture
 * edits the types' lines before it restores them.
 */
const KEPT = "user.guided-kept";
const LONG = "user.stored-long";
const APP = "app.guided.note";
const BESIDE = "user.guided-beside-app";

const GUIDANCE = "Use for a shop's orders.\n\n## Not for\n\nQuotes.";
const WORD = "Nobody has looked yet.";

let origin: FreshServer;
let destination: FreshServer;
let source: MarfaClient;
let worker: MarfaClient;
let restoring: MarfaClient;
let exported: Uint8Array;

type Line = {
  type?: {
    id?: string;
    description?: string;
    guidance?: string;
    fields?: Record<
      string,
      { description?: string; status_values?: { description?: string }[] }
    >;
  };
};

/** The archive with `edit` applied to each type line it names. */
function edited(
  archive: Uint8Array,
  ids: string[],
  edit: (line: Line) => void,
): Uint8Array {
  let touched = 0;
  const out = editLineFile(archive, "instance", (text) =>
    text
      .split("\n")
      .map((raw) => {
        if (raw === "") return raw;
        const line = JSON.parse(raw) as Line;
        if (line.type?.id === undefined || !ids.includes(line.type.id))
          return raw;
        edit(line);
        touched += 1;
        return JSON.stringify(line);
      })
      .join("\n"),
  );
  expect(touched, "the archive holds the type lines").toBe(ids.length);
  return out;
}

beforeAll(async () => {
  [origin, destination] = await Promise.all([
    bootFreshServer("guidance-origin"),
    bootFreshServer("guidance-destination"),
  ]);
  source = new MarfaClient({
    baseUrl: origin.apiUrl,
    apiKey: origin.workingKey,
  });
  const fields = {
    stage: {
      type: "status",
      description: "Where it stands.",
      status_values: [
        { value: "open", group: "not_started", description: WORD },
        { value: "done", group: "completed" },
      ],
    },
  };
  for (const body of [
    { id: KEPT, description: "Orders.", guidance: GUIDANCE, fields },
    { id: LONG, description: "Short.", guidance: "Short.", fields },
    { id: APP, fields },
    { id: BESIDE, fields },
  ]) {
    const made = await source.registerType(body as never);
    expect(made.status, JSON.stringify(made.error)).toBe(201);
  }
  const archive = await source.exportArchive({ state: "any" });
  expect(archive.status).toBe(200);
  exported = archive.data;
  restoring = new MarfaClient({
    baseUrl: destination.apiUrl,
    controlSocket: destination.controlSocket,
  });
  worker = new MarfaClient({
    baseUrl: destination.apiUrl,
    apiKey: destination.workingKey,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all([origin?.stop(), destination?.stop()]);
}, FRESH_SERVER_TIMEOUT_MS);

describe("a type's guidance and descriptions in an archive", () => {
  it("refuses an archive that gives an app type guidance, and writes nothing", async () => {
    const bad = edited(exported, [APP, BESIDE], (line) => {
      if (line.type?.id === APP) line.type.guidance = "Use it.";
    });
    const refused = await restoring.restoreArchive(bad);
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_schema");
    expect(JSON.stringify(refused.error?.error.details)).toContain("guidance");
    // Nothing was written: not the app type, and not the type beside it.
    expect((await worker.getType(APP)).status).toBe(404);
    expect((await worker.getType(BESIDE)).status).toBe(404);
  });

  it("carries a type's guidance and status word descriptions through an export and a restore into a new instance", async () => {
    const restored = await restoring.restoreArchive(exported);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    const read = (await worker.getType(KEPT)).data;
    expect(read.guidance).toBe(GUIDANCE);
    expect(read.fields.stage.status_values).toEqual([
      { value: "open", group: "not_started", description: WORD },
      { value: "done", group: "completed" },
    ]);
    // The witness: the archive without the app type's guidance restores it, so the refusal above was the guidance.
    expect((await worker.getType(APP)).status).toBe(200);
    expect((await worker.getType(BESIDE)).status).toBe(200);
  });

  it("reads a type stored over the limits as it is, and refuses a replacement that keeps the text until it is within", async () => {
    // The witness: the same text is refused when it is registered.
    const direct = await source.registerType({
      id: `${LONG}-direct`,
      description: "d".repeat(300),
      fields: { title: { type: "string" } },
    } as never);
    expect(direct.status).toBe(400);
    expect(direct.error?.error.code).toBe("invalid_schema");

    const destinationTwo = await bootFreshServer("guidance-long-destination");
    try {
      const long = edited(exported, [LONG], (line) => {
        const type = line.type!;
        type.description = "d".repeat(300);
        type.guidance = "g".repeat(2000);
        type.fields!.stage.description = "f".repeat(400);
        type.fields!.stage.status_values![0].description = "w".repeat(200);
      });
      const restoredLong = await new MarfaClient({
        baseUrl: destinationTwo.apiUrl,
        controlSocket: destinationTwo.controlSocket,
      }).restoreArchive(long);
      expect(restoredLong.status, JSON.stringify(restoredLong.error)).toBe(200);
      const own = new MarfaClient({
        baseUrl: destinationTwo.apiUrl,
        apiKey: destinationTwo.workingKey,
      });
      const held = (await own.getType(LONG)).data;
      expect(held.description).toBe("d".repeat(300));
      expect(held.guidance).toBe("g".repeat(2000));
      expect(held.fields.stage.description).toBe("f".repeat(400));
      expect(held.fields.stage.status_values?.[0].description).toBe(
        "w".repeat(200),
      );
      const listed = (await own.listTypes()).data.data.find(
        (t) => t.id === LONG,
      );
      expect(listed?.description).toBe("d".repeat(300));

      // A replacement that keeps any of the text is refused, naming each.
      const { provenance: _provenance, ...whole } = held;
      const kept = await own.replaceType(LONG, whole);
      expect(kept.status).toBe(400);
      expect(kept.error?.error.code).toBe("invalid_schema");
      const named = JSON.stringify(kept.error?.error.details);
      for (const path of [
        "description",
        "guidance",
        "fields.stage.description",
        "fields.stage.status_values.0.description",
      ]) {
        expect(named, path).toContain(`"${path}"`);
      }
      expect((await own.getType(LONG)).data).toEqual(held);

      // One that brings it within is taken.
      const fits = await own.replaceType(LONG, {
        ...whole,
        description: "Short.",
        guidance: "Short.",
        fields: {
          stage: {
            ...whole.fields.stage,
            description: "Where it stands.",
            status_values: [
              { value: "open", group: "not_started", description: "Open." },
              { value: "done", group: "completed" },
            ],
          },
        },
      });
      expect(fits.status, JSON.stringify(fits.error)).toBe(200);
    } finally {
      await destinationTwo.stop();
    }
  });
});

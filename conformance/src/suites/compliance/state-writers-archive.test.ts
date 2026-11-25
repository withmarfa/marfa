import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { controlRequest } from "../../utils/control-request.js";
import { editLineFile, readLineFile } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

let server: FreshServer;
let target: FreshServer;

beforeAll(async () => {
  [server, target] = await Promise.all([
    bootFreshServer("state-writers-archive"),
    bootFreshServer("state-writers-archive-restore"),
  ]);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all([server?.stop(), target?.stop()]);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

interface Writer {
  kind: string;
  id: string;
  name: string;
}

interface Minted {
  id: string;
  key: string;
  label: string;
  source: string;
}

async function mintKey(
  label: string,
  typePermissions: Record<string, string> = { "core.note": "write" },
): Promise<Minted> {
  const minted = await controlRequest(server.controlSocket, "/keys", {
    method: "POST",
    body: {
      label,
      source: `state-writers-archive-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`,
      type_permissions: typePermissions,
    },
  });
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  return minted.body as unknown as Minted;
}

function as(minted: Minted): Writer {
  return { kind: "key", id: minted.id, name: minted.label };
}

async function createNote(minted: Minted, body: string): Promise<string> {
  const created = await new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: minted.key,
  }).createItem({ type: "core.note", properties: { body } });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  return created.data.item.id;
}

async function exported(source: string): Promise<Uint8Array> {
  const exporter = await mintKey("state exporter", { "core.note": "read" });
  const archive = await new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: exporter.key,
  }).exportArchive({ type: "core.note", source });
  expect(archive.status).toBe(200);
  return archive.data;
}

type Line = { item: { id: string }; state_writer?: unknown };

function lines(archive: Uint8Array): Line[] {
  return (readLineFile(archive, "items") ?? "")
    .split("\n")
    .filter((text) => text.trim() !== "")
    .map((text) => JSON.parse(text) as Line);
}

async function restore(archive: Uint8Array) {
  return new MarfaClient({
    baseUrl: target.apiUrl,
    apiKey: "",
    controlSocket: target.controlSocket,
  }).restoreArchive(archive);
}

async function stateWriterOf(id: string): Promise<Writer | null | undefined> {
  const answer = await fetch(
    `${target.apiUrl}/items/${id}?include=writer&state=any`,
    { headers: { authorization: `Bearer ${target.workingKey}` } },
  );
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { item: { state_writer?: Writer | null } })
    .item.state_writer;
}

describe("who made an item's last state move, through an archive", () => {
  it("carries the state writer on each item's line, null where the item never moved, and keeps it on restore", async () => {
    const author = await mintKey("archived state author");
    const mover = await mintKey("archived state mover");
    const binner = await mintKey("archived state binner");
    const moved = await createNote(author, "archived by a key");
    const binned = await createNote(author, "restored by a key");
    const unmoved = await createNote(author, "never moved");
    const client = (minted: Minted) =>
      new MarfaClient({ baseUrl: server.apiUrl, apiKey: minted.key });
    expect((await client(mover).transitionItem(moved, "archived")).status).toBe(
      200,
    );
    expect((await client(author).deleteItem(binned)).status).toBe(200);
    expect((await client(binner).restoreItem(binned)).status).toBe(200);

    const archive = await exported(author.source);
    const byId = Object.fromEntries(
      lines(archive).map((line) => [line.item.id, line]),
    );
    expect(byId[moved]!.state_writer).toEqual(as(mover));
    expect(byId[binned]!.state_writer).toEqual(as(binner));
    expect(byId[unmoved]).toHaveProperty("state_writer", null);

    const restored = await restore(archive);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(await stateWriterOf(moved)).toEqual(as(mover));
    expect(await stateWriterOf(binned)).toEqual(as(binner));
    expect(await stateWriterOf(unmoved)).toBeNull();
  });

  it("restores an archive that names no state writer with none, without refusing it", async () => {
    const author = await mintKey("forgotten state author");
    const mover = await mintKey("forgotten state mover");
    const id = await createNote(author, "forgotten");
    expect(
      (
        await new MarfaClient({
          baseUrl: server.apiUrl,
          apiKey: mover.key,
        }).transitionItem(id, "archived")
      ).status,
    ).toBe(200);
    const archive = await exported(author.source);
    let stripped = 0;
    const forgotten = editLineFile(archive, "items", (body) =>
      body
        .split("\n")
        .filter((text) => text.trim() !== "")
        .map((text) => {
          const line = JSON.parse(text) as Line;
          // The witness: the export named a state writer to take out.
          if (line.state_writer) stripped += 1;
          delete line.state_writer;
          return `${JSON.stringify(line)}\n`;
        })
        .join(""),
    );
    expect(stripped).toBe(1);
    const restored = await restore(forgotten);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(await stateWriterOf(id)).toBeNull();
  });

  it("refuses an archive that names a malformed state writer", async () => {
    const author = await mintKey("malformed state author");
    const id = await createNote(author, "malformed");
    const archive = await exported(author.source);
    const edits: [string, (line: Line) => void][] = [
      [
        "state_writer.kind",
        (l) => {
          l.state_writer = { kind: "robot", id: "x", name: "x" };
        },
      ],
      [
        "state_writer.id",
        (l) => {
          l.state_writer = { kind: "key", id: "", name: "x" };
        },
      ],
      [
        "state_writer",
        (l) => {
          l.state_writer = "a key";
        },
      ],
    ];
    for (const [field, edit] of edits) {
      const edited = editLineFile(archive, "items", (body) =>
        body
          .split("\n")
          .filter((text) => text.trim() !== "")
          .map((text) => {
            const line = JSON.parse(text) as Line;
            if (line.item.id === id) edit(line);
            return `${JSON.stringify(line)}\n`;
          })
          .join(""),
      );
      const refused = await restore(edited);
      expect(refused.status, field).toBe(400);
      expect(refused.error?.error.code, field).toBe("validation_error");
      expect(
        (refused.error?.error.details as { field?: string } | undefined)?.field,
        field,
      ).toBe(field);
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, CliFolder, newStore } from "../../device/cli-adapter.js";
import type {
  BodyLinks,
  BodyTarget,
  Outcome,
  QueuedWrite,
} from "../../device/protocol.js";
import {
  cleanup,
  createTestContext,
  trackFolder,
  trackItem,
} from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

// `device.md` 88 to 99: a body written through a working copy, against the
// run's server.

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let device: CliDevice;
const dirs: string[] = [];

beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "body-edges",
  ));
  device = await copy();
});
afterAll(async () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  if (ctx) await cleanup(ctx);
});

function value<T>(result: Outcome<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.refusal.raw);
  return result.value;
}

async function copy(url = apiUrl): Promise<CliDevice> {
  const made = new CliDevice({
    binary: requireBinary(),
    store: newStore("body-edges"),
    url,
    key: apiKey,
  });
  value(await made.hydrate(["core.note", "core.file"], "library"));
  return made;
}

function named(label: string): string {
  return `${label} ${ctx.runId}`;
}

/** A note the device creates and queues, its id tracked for cleanup. */
async function note(
  on: CliDevice,
  title: string,
  body = "",
): Promise<{ id: string; write: QueuedWrite }> {
  const write = value(
    await on.create({ type: "core.note", properties: { title, body } }),
  );
  trackItem(ctx, write.item_id!);
  return { id: write.item_id!, write };
}

/** A note only the server holds until the device catches up. */
async function remoteNote(title: string): Promise<string> {
  const made = await client.createItem({
    type: "core.note",
    properties: { title, body: "" },
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackItem(ctx, made.data.item.id);
  return made.data.item.id;
}

async function setBody(on: CliDevice, id: string, body: string) {
  const held = value(await on.get(id));
  return value(
    await on.update(id, { version: held.version, properties: { body } }),
  );
}

async function drained(on: CliDevice) {
  const report = value(await on.drain());
  expect(report.unavailable).toBeNull();
  return report;
}

/** The writes still to be sent, oldest first. */
async function unsent(on: CliDevice): Promise<QueuedWrite[]> {
  return value(await on.queue()).filter((write) => write.verdict === null);
}

async function referencesFrom(id: string): Promise<string[]> {
  const listed = await client.listItemEdges(id, { edge_type: "references" });
  expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
  return listed.data.data.map((edge) => edge.target_id).sort();
}

async function attachedTo(id: string): Promise<string[]> {
  const listed = await client.listItemBackrefs(id, {
    edge_type: "attached-to",
  });
  expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
  return listed.data.data.map((edge) => edge.source_id).sort();
}

function targets(names: BodyLinks["links"]): BodyTarget[] {
  return names.map((name) => name.target);
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "marfa-body-edges-"));
  dirs.push(dir);
  return dir;
}

describe("links", () => {
  it("makes a references edge for a link to a held item, to one created earlier in the queue, and to one only the server holds", async () => {
    const held = await note(device, named("Held"));
    await drained(device);
    const remote = await remoteNote(named("Remote"));
    const later = await note(device, named("Later"));
    const host = await note(
      device,
      named("Host"),
      `[[${named("Held")}]] then [[${named("Later")}]] then [[${named("Remote")}]] and [[${named("Held")}]] again`,
    );
    expect(
      (await unsent(device)).filter((write) => write.kind === "create_edge"),
      "a title was taken as naming one item before the server was asked",
    ).toEqual([]);
    expect(targets(value(await device.bodyLinks(host.id)).links)).toEqual([
      { state: "pending" },
      { state: "pending" },
      { state: "pending" },
    ]);
    const report = await drained(device);
    const edges = report.verdicts.filter(
      (verdict) => verdict.kind === "create_edge",
    );
    expect(edges.map((verdict) => verdict.verdict)).toEqual([
      "accepted",
      "accepted",
      "accepted",
    ]);
    expect(await referencesFrom(host.id)).toEqual(
      [held.id, later.id, remote].sort(),
    );
    expect(targets(value(await device.bodyLinks(host.id)).links)).toEqual([
      { state: "item", id: held.id },
      { state: "item", id: later.id },
      { state: "item", id: remote },
    ]);
  });

  it("queues no edge write for an edit that leaves the body as it was", async () => {
    const target = await note(device, named("Unchanged target"));
    const body = `see [[${named("Unchanged target")}]]`;
    const host = await note(device, named("Unchanged host"), body);
    await drained(device);
    expect(await referencesFrom(host.id)).toEqual([target.id]);
    let held = value(await device.get(host.id));
    value(
      await device.update(host.id, {
        version: held.version,
        properties: { title: named("Unchanged host renamed") },
      }),
    );
    held = value(await device.get(host.id));
    value(
      await device.update(host.id, {
        version: held.version,
        properties: { body },
      }),
    );
    expect((await unsent(device)).map((write) => write.kind)).toEqual([
      "update_item",
      "update_item",
    ]);
    await drained(device);
    expect(await referencesFrom(host.id)).toEqual([target.id]);
  });

  it("takes the edge with a link taken out, and leaves edges of another type and ones no body named", async () => {
    const gone = await note(device, named("Gone"));
    const kept = await note(device, named("Kept"));
    const elsewhere = await remoteNote(named("Elsewhere"));
    const host = await note(
      device,
      named("Removal host"),
      `[[${named("Gone")}]] [[${named("Kept")}]]`,
    );
    await drained(device);
    value(
      await device.createEdge({
        source: host.id,
        target: gone.id,
        type: "about",
      }),
    );
    const made = await client.createEdge({
      source_id: host.id,
      target_id: elsewhere,
      edge_type: "references",
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    await drained(device);
    value(await device.catchUp());
    await setBody(device, host.id, `only [[${named("Kept")}]]`);
    const deletes = (await unsent(device)).filter(
      (write) => write.kind === "delete_edge",
    );
    expect(deletes.map((write) => [write.item_id, write.target_id])).toEqual([
      [host.id, gone.id],
    ]);
    await drained(device);
    expect(await referencesFrom(host.id)).toEqual([kept.id, elsewhere].sort());
    const about = await client.listItemEdges(host.id, { edge_type: "about" });
    expect(about.ok).toBe(true);
    expect(about.data.data.map((edge) => edge.target_id)).toEqual([gone.id]);
  });

  it("reads an alias and a heading as the name before them, and a link in code as text", async () => {
    const alias = await note(device, named("Alias"));
    const heading = await note(device, named("Heading"));
    await note(device, named("Coded"));
    const host = await note(
      device,
      named("Forms host"),
      `[[${named("Alias")}|shown]] [[${named("Heading")}#Part]] [[#local]]\n\`[[${named("Coded")}]]\`\n\`\`\`\n[[${named("Coded")}]]\n\`\`\`\n`,
    );
    await drained(device);
    expect(await referencesFrom(host.id)).toEqual(
      [alias.id, heading.id].sort(),
    );
    const links = value(await device.bodyLinks(host.id)).links;
    expect(links.map((link) => [link.text, link.name, link.target])).toEqual([
      [
        `[[${named("Alias")}|shown]]`,
        named("Alias"),
        { state: "item", id: alias.id },
      ],
      [
        `[[${named("Heading")}#Part]]`,
        named("Heading"),
        { state: "item", id: heading.id },
      ],
    ]);
  });

  it("reports a name it cannot resolve, keeps the body as typed, and resolves it once the item arrives by catch-up", async () => {
    const body = `waiting on [[${named("Nobody yet")}]]`;
    const host = await note(device, named("Waiting host"), body);
    await drained(device);
    expect(targets(value(await device.bodyLinks(host.id)).links)).toEqual([
      { state: "missing" },
    ]);
    const stored = await client.getItem(host.id);
    expect(stored.ok).toBe(true);
    expect(stored.data.item.properties.body).toBe(body);
    expect(await referencesFrom(host.id)).toEqual([]);
    // A drain before the item exists changes nothing.
    await drained(device);
    expect(await referencesFrom(host.id)).toEqual([]);
    const arrived = await remoteNote(named("Nobody yet"));
    value(await device.catchUp());
    await drained(device);
    expect(await referencesFrom(host.id)).toEqual([arrived]);
    expect(targets(value(await device.bodyLinks(host.id)).links)).toEqual([
      { state: "item", id: arrived },
    ]);
  });

  it("resolves a waiting name at the next hydration", async () => {
    const fresh = await copy();
    const host = await note(
      fresh,
      named("Hydration host"),
      `[[${named("Hydrated later")}]]`,
    );
    await drained(fresh);
    expect(targets(value(await fresh.bodyLinks(host.id)).links)).toEqual([
      { state: "missing" },
    ]);
    const arrived = await remoteNote(named("Hydrated later"));
    value(await fresh.hydrate(["core.note", "core.file"], "library"));
    await drained(fresh);
    expect(await referencesFrom(host.id)).toEqual([arrived]);
  });

  it("reports an ambiguous name and makes no edge", async () => {
    await remoteNote(named("Twin"));
    await remoteNote(named("Twin"));
    value(await device.catchUp());
    const host = await note(device, named("Twin host"), `[[${named("Twin")}]]`);
    await drained(device);
    expect(targets(value(await device.bodyLinks(host.id)).links)).toEqual([
      { state: "ambiguous" },
    ]);
    expect(await referencesFrom(host.id)).toEqual([]);
  });

  it("reports a refused edge write against its link, and keeps the body", async () => {
    const target = await remoteNote(named("Binned"));
    value(await device.catchUp());
    const body = `by id [[${target}]]`;
    const host = await note(device, named("Refused host"), body);
    const queued = (await unsent(device)).filter(
      (write) => write.kind === "create_edge" && write.item_id === host.id,
    );
    expect(queued, "a held id waited for the server").toHaveLength(1);
    const binned = await client.deleteItem(target);
    expect(binned.ok, JSON.stringify(binned.error)).toBe(true);
    const report = await drained(device);
    const edge = report.verdicts.find((verdict) => verdict.id === queued[0].id);
    expect(edge?.verdict).toBe("refused");
    const link = value(await device.bodyLinks(host.id)).links[0];
    expect(link.target.state).toBe("refused");
    const stored = await client.getItem(host.id);
    expect(stored.ok).toBe(true);
    expect(stored.data.item.properties.body).toBe(body);
    expect(
      value(await device.queue()).find((write) => write.id === queued[0].id)
        ?.verdict,
      "a refused edge left the queue without a discard",
    ).toBe("refused");
  });
});

describe("embeds", () => {
  it("makes an embed of an image and of a video, by name and by path, the file's attached-to edge", async () => {
    const dir = scratch();
    mkdirSync(join(dir, "media"));
    const photoName = `photo-${ctx.runId}.png`;
    const clipName = `clip-${ctx.runId}.mp4`;
    writeFileSync(join(dir, photoName), `png ${ctx.runId}`);
    writeFileSync(join(dir, "media", clipName), `mp4 ${ctx.runId}`);
    const photo = value(await device.addFile(join(dir, photoName)))[1];
    const clip = value(await device.addFile(join(dir, "media", clipName)))[1];
    for (const file of [photo, clip]) trackItem(ctx, file.item_id!);
    await drained(device);
    const host = await note(
      device,
      named("Embed host"),
      `![[${photoName}]] and ![](media/${clipName}) and ![[A note]] and ![](${ctx.runId}.md)`,
    );
    expect(
      targets(value(await device.bodyLinks(host.id)).embeds),
      "an embed of a note was read as a file",
    ).toEqual([{ state: "pending" }, { state: "pending" }]);
    await drained(device);
    expect(await attachedTo(host.id)).toEqual(
      [photo.item_id!, clip.item_id!].sort(),
    );
    const embeds = value(await device.bodyLinks(host.id)).embeds;
    expect(embeds.map((embed) => [embed.text, embed.target])).toEqual([
      [`![[${photoName}]]`, { state: "item", id: photo.item_id! }],
      [`![](media/${clipName})`, { state: "item", id: clip.item_id! }],
    ]);
    await setBody(device, host.id, `![](${photoName}) ![[${clipName}]]`);
    expect(
      (await unsent(device)).map((write) => write.kind),
      "the same files named another way churned their edges",
    ).toEqual(["update_item"]);
    await drained(device);
    await setBody(device, host.id, `![[${clipName}]]`);
    const deletes = (await unsent(device)).filter(
      (write) => write.kind === "delete_edge",
    );
    expect(deletes.map((write) => [write.item_id, write.target_id])).toEqual([
      [photo.item_id!, host.id],
    ]);
    await drained(device);
    expect(await attachedTo(host.id)).toEqual([clip.item_id!]);
    const kept = await client.getItem(photo.item_id!);
    expect(kept.ok, "taking the embed out took the file item").toBe(true);
    expect(kept.data.item.type).toBe("core.file.image");
  });

  it("embeds an attached file by the text the attach answers, with no second edge", async () => {
    const dir = scratch();
    const name = `pasted-${ctx.runId}.png`;
    writeFileSync(join(dir, name), `pasted ${ctx.runId}`);
    const host = await note(device, named("Attach host"));
    const first = value(await device.attach(host.id, join(dir, name)));
    const second = value(await device.attach(host.id, join(dir, name)));
    const files = [first[1].item_id!, second[1].item_id!];
    for (const file of files) trackItem(ctx, file);
    const texts = [];
    for (const file of files) {
      texts.push(value(await device.embedText(host.id, file)).embed);
    }
    expect(texts).toEqual([`![[${name}]]`, `![[pasted-${ctx.runId} 2.png]]`]);
    const before = (await unsent(device)).length;
    await setBody(device, host.id, texts.join("\n"));
    const after = await unsent(device);
    expect(after.length, "the embed made a second edge").toBe(before + 1);
    expect(after.at(-1)?.kind).toBe("update_item");
    expect(targets(value(await device.bodyLinks(host.id)).embeds)).toEqual(
      files.map((id) => ({ state: "item", id })),
    );
    await drained(device);
    expect(await attachedTo(host.id)).toEqual([...files].sort());
    const refused = await device.embedText(host.id, host.id);
    expect(refused.ok, "a note was given embed text").toBe(false);
  });
});

describe("between writers", () => {
  it("settles an edge two copies both made as one, and leaves no refusal", async () => {
    const other = await copy();
    const target = await remoteNote(named("Raced"));
    const host = await note(device, named("Race host"));
    await drained(device);
    value(await other.catchUp());
    value(await device.catchUp());
    await setBody(device, host.id, `[[${target}]]`);
    await setBody(other, host.id, `[[${target}]] too`);
    await drained(device);
    const report = await drained(other);
    const duplicate = report.verdicts.find(
      (verdict) => verdict.kind === "create_edge",
    );
    expect(duplicate?.verdict).toBe("refused");
    expect(
      value(await other.queue()).filter(
        (write) => write.kind === "create_edge",
      ),
      "a duplicate edge stayed in the queue to discard",
    ).toEqual([]);
    expect(await referencesFrom(host.id)).toEqual([target]);
    value(await other.catchUp());
    expect(targets(value(await other.bodyLinks(host.id)).links)).toEqual([
      { state: "item", id: target },
    ]);
  });

  it("sends no edge write whose body lost to another device's, and keeps the edge the kept body names", async () => {
    const other = await copy();
    const target = await note(device, named("Contested target"));
    const host = await note(
      device,
      named("Contested host"),
      `[[${named("Contested target")}]] and text`,
    );
    await drained(device);
    value(await other.catchUp());
    await setBody(device, host.id, "text alone");
    expect(
      (await unsent(device)).map((write) => write.kind),
      "taking the link out queued no delete",
    ).toEqual(["update_item", "delete_edge"]);
    await setBody(
      other,
      host.id,
      `[[${named("Contested target")}]] and text, edited elsewhere`,
    );
    await drained(other);
    const report = await drained(device);
    expect(
      report.verdicts.find((verdict) => verdict.kind === "update_item")
        ?.verdict,
    ).toBe("conflicted");
    expect(
      report.verdicts.find((verdict) => verdict.kind === "delete_edge")
        ?.verdict,
    ).toBe("refused");
    expect(await referencesFrom(host.id)).toEqual([target.id]);
    expect(
      value(await device.queue()).filter(
        (write) => write.kind === "delete_edge" && write.verdict === "refused",
      ),
      "an edge write a lost body made stayed in the queue to discard",
    ).toEqual([]);
    value(await device.catchUp());
    expect(targets(value(await device.bodyLinks(host.id)).links)).toEqual([
      { state: "item", id: target.id },
    ]);
  });

  it("waits offline, and resolves and sends at the drain after reconnecting", async () => {
    let down = false;
    const proxy: Server = createServer(async (request, response) => {
      if (down) {
        request.socket.destroy();
        return;
      }
      try {
        const bytes: Buffer[] = [];
        for await (const chunk of request) bytes.push(Buffer.from(chunk));
        const body = Buffer.concat(bytes);
        const headers = new Headers();
        for (const [name, header] of Object.entries(request.headers)) {
          if (
            header !== undefined &&
            ![
              "host",
              "connection",
              "transfer-encoding",
              "content-length",
            ].includes(name)
          )
            headers.set(
              name,
              Array.isArray(header) ? header.join(", ") : header,
            );
        }
        const upstream = await fetch(
          `${apiUrl.replace(/\/$/, "")}${request.url}`,
          {
            method: request.method,
            headers,
            ...(body.length ? { body } : {}),
          },
        );
        const returned = Object.fromEntries(upstream.headers);
        delete returned["content-length"];
        delete returned["content-encoding"];
        response.writeHead(upstream.status, returned);
        if (!upstream.body) response.end();
        else {
          const stream = Readable.fromWeb(
            upstream.body as import("node:stream/web").ReadableStream,
          );
          stream.on("error", () => response.destroy());
          response.on("close", () => stream.destroy());
          stream.pipe(response);
        }
      } catch {
        response.destroy();
      }
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const address = proxy.address();
      if (!address || typeof address === "string")
        throw new Error("no proxy port");
      const offline = await copy(`http://127.0.0.1:${address.port}`);
      const target = await remoteNote(named("Reached"));
      value(await offline.catchUp());
      down = true;
      const host = await note(
        offline,
        named("Offline host"),
        `[[${named("Reached")}]]`,
      );
      const away = value(await offline.drain());
      expect(
        away.unavailable,
        "the drain reached a server that was down",
      ).not.toBeNull();
      expect(targets(value(await offline.bodyLinks(host.id)).links)).toEqual([
        { state: "pending" },
      ]);
      down = false;
      await drained(offline);
      expect(await referencesFrom(host.id)).toEqual([target]);
      expect(targets(value(await offline.bodyLinks(host.id)).links)).toEqual([
        { state: "item", id: target },
      ]);
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("agrees with a folder on the same item, and neither repeats the other's edge", async () => {
    const dir = scratch();
    const folder = new CliFolder(dir, {
      binary: requireBinary(),
      url: apiUrl,
      key: apiKey,
      registry: join(dir, "registry.json"),
    });
    const settings = await client.createFolder({
      title: named("Body edges folder"),
      search: { types: ["core.note"], filter: `source eq "${ctx.source}"` },
    });
    expect(settings.ok, JSON.stringify(settings.error)).toBe(true);
    trackFolder(ctx, settings.data.item.id);
    const target = await note(device, named("Shared target"));
    const other = await note(device, named("Shared other"));
    const host = await note(
      device,
      named("Shared host"),
      `[[${named("Shared target")}]]`,
    );
    await drained(device);
    value(await folder.add(settings.data.item.id));
    value(await folder.hydrate());
    value(await folder.pull());
    const path = join(dir, `${named("Shared host")}.md`);
    let text = readFileSync(path, "utf8");
    expect(text).toContain(`[[${named("Shared target")}]]`);
    expect(text, "a line repeats the body's link").not.toContain("references:");
    writeFileSync(
      path,
      text.replace(
        `[[${named("Shared target")}]]`,
        `[[${named("Shared target")}]] [[${named("Shared other")}]]`,
      ),
    );
    const pushed = value(await folder.push());
    expect(pushed.scan.flagged).toEqual([]);
    expect(await referencesFrom(host.id)).toEqual([target.id, other.id].sort());
    value(await device.catchUp());
    expect(targets(value(await device.bodyLinks(host.id)).links)).toEqual([
      { state: "item", id: target.id },
      { state: "item", id: other.id },
    ]);
    await setBody(device, host.id, `[[${named("Shared other")}]]`);
    expect(
      (await unsent(device)).map((write) => write.kind),
      "the copy made again an edge the folder made",
    ).toEqual(["update_item", "delete_edge"]);
    await drained(device);
    expect(await referencesFrom(host.id)).toEqual([other.id]);
    value(await folder.push());
    text = readFileSync(path, "utf8");
    expect(text).not.toContain(`[[${named("Shared target")}]]`);
    expect(text).not.toContain("references:");
  });
});

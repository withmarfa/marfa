import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type {
  RowOperation,
  SearchResult,
  TestContext,
} from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import {
  callTool,
  connectMcp,
  toolResult,
  type McpConnection,
} from "../../utils/mcp.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
} from "../../utils/fresh-server.js";
import { QUIET_SCHEDULE, runJob, writerOf } from "../../utils/moved-clock.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let mcp: McpConnection;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "table-rows-search",
  ));
  mcp = await connectMcp(apiUrl, apiKey);
});

afterAll(async () => {
  await mcp?.close();
  await cleanup(ctx);
});

let counter = 0;

/** A word no other fixture writes, which the tokenizer keeps whole. */
function word(): string {
  counter += 1;
  return `qz${String(counter)}x${ctx.runId.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
}

const MESSAGES = {
  author: { type: "string" },
  subject: { type: "string", searchable: true },
  text: { type: "string", searchable: true },
  ref: { type: "item" },
  n: { type: "number" },
};

function chatTables(messages: Record<string, unknown> = MESSAGES) {
  return {
    messages: { label: "Messages", columns: messages },
    notes: { columns: { body: { type: "string", searchable: true } } },
  };
}

async function chatType(on: MarfaClient = client): Promise<string> {
  counter += 1;
  const type = `user.rows-search-${String(counter)}-${ctx.runId}`;
  const made = await on.registerType({
    id: type,
    fields: { title: { type: "string" }, body: { type: "string" } },
    tables: chatTables(),
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return type;
}

async function chat(
  type: string,
  properties: Record<string, unknown> = { title: "Chat" },
  on: MarfaClient = client,
): Promise<string> {
  const made = await on.createItem({
    type,
    source: ctx.source,
    properties,
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackItem(ctx, made.data.item.id);
  return made.data.item.id;
}

async function write(
  item: string,
  table: string,
  operations: RowOperation[],
  on: MarfaClient = client,
) {
  const res = await on.writeRows(item, table, { operations });
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data;
}

async function put(
  item: string,
  table: string,
  rows: Record<string, unknown>[],
  ids?: string[],
  on: MarfaClient = client,
): Promise<string[]> {
  const found: string[] = [];
  for (let at = 0; at < rows.length; at += 1000) {
    const operations: RowOperation[] = rows
      .slice(at, at + 1000)
      .map((values, n) => ({
        op: "put",
        ...(ids ? { id: ids[at + n] } : {}),
        values,
      }));
    found.push(
      ...(await write(item, table, operations, on)).results.map((r) => r.id),
    );
  }
  return found;
}

async function search(
  q: string,
  filters: Parameters<MarfaClient["search"]>[1] = {},
  on: MarfaClient = client,
) {
  const res = await on.search(q, { limit: 100, ...filters });
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  await expectMatchesSchema("GET", "/search", 200, res.data);
  return res.data;
}

/** Each hit as `item`, or `item table row` for a row. */
function keys(hits: SearchResult[]): string[] {
  return hits.map((hit) =>
    hit.row
      ? `${hit.item.id} ${hit.row.table} ${hit.row.id}`
      : `${hit.item.id}`,
  );
}

async function rowKeys(q: string, on: MarfaClient = client) {
  return keys((await search(q, {}, on)).data).filter((key) =>
    key.includes(" "),
  );
}

describe("searching rows", () => {
  it("takes a table that marks 8 columns searchable and refuses one that marks 9", async () => {
    const columns = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, at) => [
          `c${String(at)}`,
          { type: "string", searchable: true },
        ]),
      );
    counter += 1;
    const id = `user.rows-search-wide-${String(counter)}-${ctx.runId}`;
    const refused = await client.registerType({
      id,
      fields: { title: { type: "string" } },
      tables: { wide: { columns: columns(9) } },
    } as never);
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_schema");
    expect(JSON.stringify(refused.error?.error.details)).toContain(
      "tables.wide.columns",
    );
    const taken = await client.registerType({
      id,
      fields: { title: { type: "string" } },
      tables: { wide: { columns: columns(8) } },
    } as never);
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
  });

  it("answers a row whose searchable column matches as a hit naming its item, table, row and column", async () => {
    const w = word();
    const type = await chatType();
    const item = await chat(type, { title: `Chat ${w}` });
    const [row] = await put(item, "messages", [
      { author: "Ann", text: `hello ${w}` },
    ]);
    const found = await search(w);
    expect(found.data).toHaveLength(2);
    const own = found.data.find((hit) => hit.row === undefined);
    const hit = found.data.find((hit) => hit.row !== undefined);
    expect(own?.item.id).toBe(item);
    expect(own).not.toHaveProperty("row");
    expect(hit?.item.id).toBe(item);
    expect(hit?.row).toEqual({ table: "messages", id: row, column: "text" });
    expect(hit?.snippet_html).toBe(`hello <mark>${w}</mark>`);
    expect(hit?.relevance_score).toBeGreaterThan(0);
    expect(hit?.metadata).toBeDefined();
  });

  it("matches a row by every word across its searchable columns, and never by a column not marked searchable or a value written as an item's id", async () => {
    const [a, b] = [word(), word()];
    const type = await chatType();
    const item = await chat(type);
    const target = await chat(type, { title: "Referenced" });
    const [across, , typed] = await put(item, "messages", [
      { subject: `${a} first`, text: `then ${b}` },
      { author: `${a} ${b}`, n: 1 },
      { subject: `about ${target}` },
      { ref: target },
    ]);
    expect(await rowKeys(`${a} ${b}`)).toEqual([`${item} messages ${across}`]);
    // A row needs every word: one alone in its columns is no match.
    expect(await rowKeys(`${a} nothingelse${b}`)).toEqual([]);

    // The id written to an item column is withheld, so no retype makes it searchable.
    const retyped = await client.replaceType(
      type,
      {
        id: type,
        fields: { title: { type: "string" }, body: { type: "string" } },
        tables: chatTables({
          ...MESSAGES,
          ref: { type: "string", searchable: true },
        }),
      },
      true,
    );
    expect(retyped.status, JSON.stringify(retyped.error)).toBe(200);
    // The witness: the same text typed into a searchable column is found.
    expect(await rowKeys(`"${target}"`)).toEqual([`${item} messages ${typed}`]);
  });

  it("ranks row hits with item hits by BM25, scoring the best hit highest", async () => {
    const w = word();
    const type = await chatType();
    const long = (n: number) =>
      Array.from({ length: n }, (_, at) => `filler${String(at)}`).join(" ");
    const short = await chat(type, { title: w });
    const verbose = await chat(type, {
      title: "Long",
      body: `${w} ${long(200)}`,
    });
    const host = await chat(type, { title: "Host" });
    const [tight, loose] = await put(host, "messages", [
      { text: w },
      { text: `${long(200)} ${w}` },
    ]);
    const found = (await search(w)).data;
    const order = keys(found);
    expect(order).toHaveLength(4);
    expect(new Set(order.slice(0, 2))).toEqual(
      new Set([short, `${host} messages ${tight}`]),
    );
    expect(new Set(order.slice(2))).toEqual(
      new Set([verbose, `${host} messages ${loose}`]),
    );
    const scores = found.map((hit) => hit.relevance_score);
    expect(scores[0]).toBe(1);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
    expect(scores[1]).toBeGreaterThan(scores[2]!);
    // Ascending turns the one ranking round.
    const worst = keys((await search(w, { direction: "asc" })).data);
    expect(new Set(worst.slice(0, 2))).toEqual(new Set(order.slice(2)));
  });

  it("scores and orders a key's hits by what it may read, whatever the items and rows it may not read hold", async () => {
    const [v, w] = [word(), word()];
    const filler = (n: number) =>
      Array.from({ length: n }, (_, at) => `pad${String(at)}`).join(" ");
    const mine = await chatType();
    const theirs = await chatType();
    await chat(mine, { title: `${v} ${w}` });
    await chat(mine, { title: "Long", body: `${v} ${w} ${w} ${filler(30)}` });
    const host = await chat(mine, { title: "Host" });
    await put(host, "messages", [
      { text: `${v} ${w}` },
      { text: `${v} ${v} ${w} ${filler(20)}` },
      { subject: v, text: `${w} ${filler(5)}` },
    ]);
    const hidden = await chat(theirs, { title: "Hidden" });
    const [secret] = await put(hidden, "messages", [{ text: `${w} once` }]);

    counter += 1;
    const made = await client.createKey({
      label: `rows-search-score-${String(counter)}`,
      source: `${ctx.source}-score-${String(counter)}`,
      type_permissions: { [mine]: "read" },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackKey(ctx, made.data.id);
    const narrow = new MarfaClient({ baseUrl: apiUrl, apiKey: made.data.key });
    const scored = async (on: MarfaClient) => {
      const hits = (await search(`${v} ${w}`, {}, on)).data;
      return keys(hits).map((key, at) => `${key} ${String(hits[at]!.relevance_score)}`);
    };
    const before = await scored(narrow);
    expect(before).toHaveLength(5);
    const visible = (lines: string[]) =>
      lines.filter((line) =>
        before.some((seen) => line.startsWith(seen.slice(0, seen.lastIndexOf(" ")))),
      );
    const ownerBefore = visible(await scored(client));

    // Only what the narrow key may not read changes: words, lengths and counts.
    await write(hidden, "messages", [
      { op: "patch", id: secret!, values: { text: `${filler(40)} ${v}` } },
    ]);
    await put(
      hidden,
      "messages",
      Array.from({ length: 30 }, (_, at) => ({ text: `${w} ${filler(at)}` })),
    );
    await chat(theirs, { title: `${w} ${w} ${v}`, body: filler(50) });

    expect(await scored(narrow)).toEqual(before);
    // The witness: a key that may read the change sees the same hits scored anew.
    expect(visible(await scored(client))).not.toEqual(ownerBefore);
  });

  it("orders a sorted search's row hits by their item's value and breaks ties by item, own hit first, then table and row id", async () => {
    const w = word();
    const type = await chatType();
    const older = await chat(type, { title: `Older ${w}` });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await chat(type, { title: `Newer ${w}` });
    const ids = [uuidv7(), uuidv7(), uuidv7(), uuidv7()].sort();
    // Written out of order, so the answer's order is the server's.
    await put(newer, "notes", [{ body: w }], [ids[0]!]);
    await put(
      newer,
      "messages",
      [{ text: w }, { text: w }],
      [ids[3]!, ids[1]!],
    );
    await put(older, "messages", [{ text: w }], [ids[2]!]);
    const newerHits = [
      newer,
      `${newer} messages ${ids[1]}`,
      `${newer} messages ${ids[3]}`,
      `${newer} notes ${ids[0]}`,
    ];
    const olderHits = [older, `${older} messages ${ids[2]}`];
    expect(keys((await search(w, { sort: "created_at" })).data)).toEqual([
      ...newerHits,
      ...olderHits,
    ]);
    expect(
      keys((await search(w, { sort: "created_at", direction: "asc" })).data),
    ).toEqual([...olderHits, ...newerHits]);
    expect(keys((await search(w, { sort: "properties.title" })).data)).toEqual([
      ...olderHits,
      ...newerHits,
    ]);
  });

  it("walks a search whose hits include rows to a null cursor, delivering every hit once", async () => {
    const w = word();
    const type = await chatType();
    const items: string[] = [];
    for (let at = 0; at < 5; at++) items.push(await chat(type, { title: w }));
    const rows = await put(
      items[0]!,
      "messages",
      Array.from({ length: 25 }, (_, at) => ({
        text: `${w} ${"more ".repeat(at)}`,
      })),
    );
    for (const sort of [undefined, "updated_at"]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await search(w, {
          limit: 7,
          ...(sort !== undefined && { sort }),
          ...(cursor !== undefined && { cursor }),
        });
        seen.push(...keys(page.data));
        if (page.next_cursor === null) break;
        cursor = page.next_cursor;
      }
      expect(seen).toHaveLength(30);
      expect(new Set(seen)).toEqual(
        new Set([
          ...items,
          ...rows.map((row) => `${items[0]} messages ${row}`),
        ]),
      );
    }
  });

  it("answers a row hit only where the search would answer its item: the key's reach, the search's narrowing and the bin", async () => {
    const w = word();
    const type = await chatType();
    const other = await chatType();
    const item = await chat(type);
    const [row] = await put(item, "messages", [{ text: w }]);
    const hit = `${item} messages ${row}`;
    // The witness: the owner's key finds the row.
    expect(await rowKeys(w)).toEqual([hit]);

    counter += 1;
    const made = await client.createKey({
      label: `rows-search-narrow-${String(counter)}`,
      source: `${ctx.source}-narrow-${String(counter)}`,
      type_permissions: { [other]: "read" },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackKey(ctx, made.data.id);
    const narrow = new MarfaClient({ baseUrl: apiUrl, apiKey: made.data.key });
    expect(await rowKeys(w, narrow)).toEqual([]);

    expect(keys((await search(w, { type: other })).data)).toEqual([]);
    expect(keys((await search(w, { type })).data)).toEqual([hit]);
    expect(keys((await search(w, { source: "elsewhere" })).data)).toEqual([]);
    expect(
      keys((await search(w, { filter: 'properties.title eq "Other"' })).data),
    ).toEqual([]);
    expect(
      keys((await search(w, { filter: 'properties.title eq "Chat"' })).data),
    ).toEqual([hit]);
    expect(keys((await search(w, { state: "archived" })).data)).toEqual([]);

    const trashed = await client.deleteItem(item);
    expect(trashed.status, JSON.stringify(trashed.error)).toBe(200);
    expect(await rowKeys(w)).toEqual([]);
    expect(keys((await search(w, { state: "any" })).data)).toEqual([]);
    expect(keys((await search(w, { state: "trashed" })).data)).toEqual([]);
    const back = await client.restoreItem(item);
    expect(back.status, JSON.stringify(back.error)).toBe(200);
    expect(await rowKeys(w)).toEqual([hit]);
  });

  it("excerpts a row hit from its searchable column with the most matched words, marked and escaped", async () => {
    const w = word();
    const type = await chatType();
    const item = await chat(type);
    const [more, tied] = await put(item, "messages", [
      { subject: `one ${w}`, text: `${w} <b>&</b> "two" ${w}` },
      { subject: `${w} first`, text: `${w} second` },
    ]);
    const found = (await search(w)).data;
    const of = (row: string) => found.find((hit) => hit.row?.id === row);
    expect(of(more!)?.row?.column).toBe("text");
    expect(of(more!)?.snippet_html).toBe(
      `<mark>${w}</mark> &lt;b&gt;&amp;&lt;/b&gt; &quot;two&quot; <mark>${w}</mark>`,
    );
    expect(of(tied!)?.row?.column).toBe("subject");
    expect(of(tied!)?.snippet_html).toBe(`<mark>${w}</mark> first`);
    // A phrase of three words outweighs two separate matches.
    const [a, b, c, d] = [word(), word(), word(), word()];
    const [phrased] = await put(item, "messages", [
      { subject: `${a}-${b}-${c}`, text: `${d} then ${d}` },
    ]);
    const byPhrase = (await search(`${a}-${b}-${c} ${d}`)).data.find(
      (hit) => hit.row?.id === phrased,
    );
    expect(byPhrase?.row?.column).toBe("subject");
    expect(byPhrase?.snippet_html).toBe(`<mark>${a}-${b}-${c}</mark>`);
    const lengthy = await put(item, "messages", [
      { text: `${"lead ".repeat(40)}${w}${" tail".repeat(40)}` },
    ]);
    const cut = (await search(w)).data.find(
      (hit) => hit.row?.id === lengthy[0],
    );
    expect(cut?.snippet_html).toMatch(/^\.\.\..*<mark>.*\.\.\.$/);
    expect(cut!.snippet_html!.split(" ").length).toBeLessThanOrEqual(32);
  });

  it("follows a row's put, patch and delete, an undo, and its item's purge", async () => {
    const [first, second, third] = [word(), word(), word()];
    const type = await chatType();
    const item = await chat(type);
    const [row] = await put(item, "messages", [{ text: first, author: "Ann" }]);
    const hit = `${item} messages ${row}`;
    expect(await rowKeys(first)).toEqual([hit]);

    await write(item, "messages", [
      { op: "patch", id: row!, values: { text: second } },
    ]);
    expect(await rowKeys(first)).toEqual([]);
    expect(await rowKeys(second)).toEqual([hit]);
    // A patch of other columns leaves the text found.
    await write(item, "messages", [
      { op: "patch", id: row!, values: { author: "Bea" } },
    ]);
    expect(await rowKeys(second)).toEqual([hit]);

    await write(item, "messages", [
      { op: "put", id: row!, values: { subject: third } },
    ]);
    expect(await rowKeys(second)).toEqual([]);
    expect(await rowKeys(third)).toEqual([hit]);

    const removed = await write(item, "messages", [{ op: "delete", id: row! }]);
    expect(await rowKeys(third)).toEqual([]);
    const undone = await client.undoBatch(item, "messages", removed.batch!);
    expect(undone.status, JSON.stringify(undone.error)).toBe(200);
    expect(await rowKeys(third)).toEqual([hit]);
    const redone = await client.undoBatch(item, "messages", undone.data.batch!);
    expect(redone.status, JSON.stringify(redone.error)).toBe(200);
    expect(await rowKeys(third)).toEqual([]);
    const again = await client.undoBatch(item, "messages", redone.data.batch!);
    expect(again.status, JSON.stringify(again.error)).toBe(200);
    expect(await rowKeys(third)).toEqual([hit]);

    expect((await client.deleteItem(item)).status).toBe(200);
    const purged = await client.purgeItem(item);
    expect(purged.status, JSON.stringify(purged.error)).toBe(200);
    expect(keys((await search(third, { state: "any" })).data)).toEqual([]);
  });

  it("follows a change to what a table marks searchable, a column removed, retyped within or away from text, and a table removed", async () => {
    const w = word();
    const type = await chatType();
    const item = await chat(type);
    const [row] = await put(item, "messages", [{ text: w }]);
    const [note] = await put(item, "notes", [{ body: w }]);
    const hits = [`${item} messages ${row}`, `${item} notes ${note}`].sort();
    const change = async (tables: Record<string, unknown>) => {
      const res = await client.replaceType(
        type,
        {
          id: type,
          fields: { title: { type: "string" }, body: { type: "string" } },
          tables,
        },
        true,
      );
      expect(res.status, JSON.stringify(res.error)).toBe(200);
    };
    const found = async () => (await rowKeys(w)).sort();
    expect(await found()).toEqual(hits);

    const { text: _text, ...withoutText } = MESSAGES;
    await change(chatTables({ ...MESSAGES, text: { type: "string" } }));
    expect(await found()).toEqual([hits[1]]);
    await change(chatTables());
    expect(await found()).toEqual(hits);
    await change(chatTables(withoutText));
    expect(await found()).toEqual([hits[1]]);
    await change(chatTables());
    expect(await found()).toEqual(hits);
    // Retyped to another text kind, the column stays searchable with its values.
    await change(
      chatTables({ ...MESSAGES, text: { type: "email", searchable: true } }),
    );
    expect(await found()).toEqual(hits);
    await change(
      chatTables({ ...MESSAGES, text: { type: "url", searchable: true } }),
    );
    expect(await found()).toEqual(hits);
    await change(chatTables({ ...MESSAGES, text: { type: "number" } }));
    expect(await found()).toEqual([hits[1]]);
    await change(chatTables());
    expect(await found()).toEqual(hits);
    await change({ messages: chatTables().messages });
    expect(await found()).toEqual([hits[0]]);
  });

  it(
    "rebuilds a large table's index through table-row-cleanup, matching nothing by a withdrawn column meanwhile",
    async () => {
      const server = await bootFreshServer(
        "rows-search-rebuild",
        QUIET_SCHEDULE,
      );
      try {
        const writer = writerOf(server);
        const w = word();
        const type = await chatType(writer);
        const made = await writer.createItem({
          type,
          properties: { title: "Large" },
        } as never);
        expect(made.status, JSON.stringify(made.error)).toBe(201);
        const item = made.data.item.id;
        const rows = Array.from({ length: 1_500 }, (_, at) => ({
          subject: `kept${w}`,
          text: `${w} ${String(at)}`,
        }));
        await put(item, "messages", rows, undefined, writer);
        const count = async (q: string) => {
          let total = 0;
          let cursor: string | undefined;
          for (;;) {
            const page = await search(
              q,
              { ...(cursor !== undefined && { cursor }) },
              writer,
            );
            total += page.data.filter((hit) => hit.row).length;
            if (page.next_cursor === null) return total;
            cursor = page.next_cursor;
          }
        };
        const change = async (searchable: boolean) => {
          const res = await writer.replaceType(type, {
            id: type,
            fields: { title: { type: "string" }, body: { type: "string" } },
            tables: chatTables({
              ...MESSAGES,
              text: { type: "string", searchable },
            }),
          });
          expect(res.status, JSON.stringify(res.error)).toBe(200);
        };
        expect(await count(w)).toBe(1_500);

        await change(false);
        expect(await count(w)).toBe(0);
        // The table is rebuilding, so its still searchable column answers nothing yet.
        expect(await count(`kept${w}`)).toBe(0);
        const run = await runJob(server, "table-row-cleanup");
        expect(run.outcome, String(run.error)).toBe("ok");
        expect(await count(w)).toBe(0);
        expect(await count(`kept${w}`)).toBe(1_500);

        await change(true);
        expect(await count(w)).toBe(0);
        expect((await runJob(server, "table-row-cleanup")).outcome).toBe("ok");
        expect(await count(w)).toBe(1_500);
      } finally {
        await server.stop();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it("counts row hits toward the depth of a search", async () => {
    const w = word();
    const type = await chatType();
    const item = await chat(type);
    await put(
      item,
      "messages",
      Array.from({ length: 10_001 }, (_, at) => ({
        text: `${w} ${String(at)}`,
      })),
    );
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const page = await search(w, {
        ...(cursor !== undefined && { cursor }),
      });
      for (const key of keys(page.data)) seen.add(key);
      if (page.next_cursor === null) break;
      expect(seen.size).toBeLessThan(10_000);
      cursor = page.next_cursor;
    }
    expect(seen.size).toBe(10_000);
  }, 300_000);

  it("names the row of a row hit in marfa_find", async () => {
    const w = word();
    const type = await chatType();
    const item = await chat(type);
    const [row] = await put(item, "messages", [{ text: `about ${w}` }]);
    const found = toolResult(
      await callTool(mcp, "marfa_find", { query: w }),
    ) as {
      items: { id: string; row?: unknown; snippet?: string }[];
    };
    expect(found.items).toEqual([
      expect.objectContaining({
        id: item,
        row: { table: "messages", id: row, column: "text" },
        snippet: `about ${w}`,
      }),
    ]);
  });
});

import { createWriteStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { bootServer, stopServer } from "../marfa-server.js";
import { controlRequest } from "../../src/utils/control-request.js";
import { parseEnvFile } from "../../src/utils/target.js";
import {
  distribution,
  scalar,
  type Figure,
} from "../../src/utils/scale/figures.js";
import { timedAnswer } from "../../src/utils/scale/answer.js";
import {
  ActivityLog,
  judgeBlob,
  judgeListing,
  ListingWalk,
  messageOf,
  MessageWalk,
  scrambled,
  type MessagePlan,
} from "../../src/utils/scale/conversation-data.js";
import { readServerMemory } from "../../src/utils/scale/memory.js";
import { StartedServers } from "../../src/utils/scale/servers.js";
import { log, ok, Recorder, type Connection } from "./context.js";
import {
  connectionOf,
  judgeWrite,
  megabytes,
  mustOk,
  recordedOnly,
  Scoreboard,
  send,
  supervisor,
  upTo,
  whole,
} from "./standalone.js";

const TABLE = "messages";
/** Messages that arrive last but were sent before every other, as an offline device's do. */
const LATE = 50;
const LATEST = 50;
const WARMUP_RUNS = 5;
const READ_RUNS = 300;
const LIST_RUNS = 30;
const WALK_LIMIT = 1000;
const LISTING_LIMIT = 500;
const DEEP_PAGES = 3;
/** Each other conversation holds message 0 then message 1, which share a `sent_at`. */
const SMALL_PLAN = {
  first: 0,
  direction: "asc",
  total: 2,
  held: 2,
} as const;
const fileText = (n: number) => `Minutes of meeting ${n}`;

interface Options {
  messages: number;
  conversations: number;
  files: number;
  appends: number;
  page: number;
  server: string;
  state: string | null;
}

function options(): Options {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      messages: { type: "string", default: "100000" },
      conversations: { type: "string", default: "1000" },
      files: { type: "string", default: "20" },
      appends: { type: "string", default: "1000" },
      page: { type: "string", default: "1000" },
      server: { type: "string", default: process.env.MARFA_SERVER_BIN ?? "" },
      state: { type: "string" },
    },
  });
  const page = whole("page", values.page, 1);
  if (page > 1000)
    throw new Error("--page is at most 1000, the most rows a batch holds");
  const appends = whole("appends", values.appends, LATE + 1);
  const messages = whole("messages", values.messages, appends + LATEST);
  if (values.server === "") {
    throw new Error(
      "--server names the marfa-server program to measure (or set MARFA_SERVER_BIN)",
    );
  }
  return {
    messages,
    conversations: whole("conversations", values.conversations, 1),
    files: whole("files", values.files, 1),
    appends,
    page,
    server: resolve(values.server),
    state: values.state === undefined ? null : resolve(values.state),
  };
}

interface Read {
  /** Milliseconds of each answer that was right. */
  times: number[];
  /** Answers refused, plus every way a read was wrong. */
  errors: number;
}

interface Walked extends Read {
  digest: string;
  problems: string[];
}

export async function conversations(): Promise<void> {
  const opts = options();
  const recorder = new Recorder("conversations");
  const board = new Scoreboard(recorder);
  const add = (figure: Figure, goal: Parameters<Scoreboard["add"]>[1]) =>
    board.add(figure, goal);

  const work =
    opts.state ?? mkdtempSync(join(tmpdir(), "marfa-scale-conversations-"));
  const stateA = join(work, "a");
  const stateB = join(work, "b");
  const started = new StartedServers();
  const exportFile = join(work, "export.tar");
  process.env.MARFA_SERVER_BIN = opts.server;
  const settings = { MARFA_TEST_HOOKS: "false" };

  const inOrder = opts.messages - LATE;
  const files: string[] = [];

  const latestPath = (id: string, limit: number) =>
    `/items/${id}/tables/${TABLE}/rows?sort=values.sent_at&direction=desc&limit=${limit}`;

  const readLatest = async (
    connection: Connection,
    id: string,
    runs: number,
    warmup = WARMUP_RUNS,
  ): Promise<Read> => {
    const result: Read = { times: [], errors: 0 };
    for (let run = -warmup; run < runs; run++) {
      const answer = await send(
        "GET",
        latestPath(id, LATEST),
        undefined,
        connection,
      );
      if (!ok(answer)) {
        result.errors++;
        log(`latest ${LATEST}: ${answer.status} ${answer.text.slice(0, 160)}`);
        continue;
      }
      const checker = new MessageWalk({
        files,
        first: inOrder - 1,
        direction: "desc",
        total: 2 * LATEST,
        held: opts.messages,
        limit: LATEST,
      });
      const body = answer.json() as { next_cursor?: unknown };
      checker.page(body, null);
      if (typeof body.next_cursor === "string") {
        const more = await send(
          "GET",
          `${latestPath(id, LATEST)}&cursor=${encodeURIComponent(body.next_cursor)}`,
          undefined,
          connection,
        );
        if (!ok(more)) {
          result.errors++;
          log(
            `latest ${LATEST}, next: ${more.status} ${more.text.slice(0, 160)}`,
          );
          continue;
        }
        checker.page(more.json(), body.next_cursor);
      }
      checker.finish();
      if (checker.problemCount > 0) {
        if (result.errors === 0) {
          for (const problem of checker.problems)
            log(`latest ${LATEST}: ${problem}`);
        }
        result.errors++;
        continue;
      }
      if (run >= 0) result.times.push(answer.ms);
    }
    return result;
  };

  const walkMessages = async (
    connection: Connection,
    id: string,
    plan: Pick<MessagePlan, "first" | "direction" | "total" | "held">,
    pages: number,
  ): Promise<Walked> => {
    const checker = new MessageWalk({
      files,
      limit: WALK_LIMIT,
      ...plan,
    });
    const base = `/items/${id}/tables/${TABLE}/rows?sort=values.sent_at&direction=${plan.direction}&limit=${WALK_LIMIT}`;
    const result: Walked = { times: [], errors: 0, digest: "", problems: [] };
    let cursor: string | null = null;
    for (let page = 0; page < pages; page++) {
      const answer = await send(
        "GET",
        cursor === null ? base : `${base}&cursor=${encodeURIComponent(cursor)}`,
        undefined,
        connection,
      );
      if (!ok(answer)) {
        result.errors++;
        log(`page ${page}: ${answer.status} ${answer.text.slice(0, 160)}`);
        break;
      }
      result.times.push(answer.ms);
      const body = answer.json() as { next_cursor?: string | null };
      checker.page(body, cursor);
      cursor = body.next_cursor ?? null;
      if (cursor === null || checker.cursorStuck) break;
    }
    checker.finish();
    result.errors += checker.problemCount;
    result.problems = checker.problems;
    result.digest = checker.digest();
    return result;
  };

  const listConversations = async (connection: Connection) => {
    const walk = new ListingWalk(opts.conversations, LISTING_LIMIT);
    let ms = 0;
    let cursor: string | null = null;
    do {
      const answer = await send(
        "GET",
        `/items?type=core.conversation&sort=last_activity_at&direction=desc&limit=${LISTING_LIMIT}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
        undefined,
        connection,
      );
      if (!ok(answer)) {
        return {
          ms,
          items: walk.items,
          failed: `${answer.status} ${answer.text.slice(0, 160)}`,
        };
      }
      ms += answer.ms;
      const step = walk.page(answer.json(), cursor);
      if (step.problem !== null) {
        return { ms, items: walk.items, failed: step.problem };
      }
      cursor = step.next;
    } while (cursor !== null);
    return { ms, items: walk.items, failed: null as string | null };
  };

  const rowCount = async (connection: Connection, id: string) => {
    const listed = await send(
      "GET",
      `/items/${id}/tables`,
      undefined,
      connection,
    );
    if (!ok(listed)) return undefined;
    return (
      listed.json() as { data: { name: string; row_count: number }[] }
    ).data.find((t) => t.name === TABLE)?.row_count;
  };

  board.startLoad();
  try {
    started.starting(stateA);
    await bootServer({ state: stateA, env: settings });
    const connection = connectionOf(stateA, "MARFA_API_KEY");
    // A key may make 4,000 requests a minute, which this run exceeds in seconds.
    mustOk(
      "turning the rate limiter off",
      await send(
        "PATCH",
        "/config",
        { rate_limit_enabled: false },
        connectionOf(stateA, "MARFA_MANAGEMENT_KEY"),
      ),
    );
    log(
      `${opts.messages} messages in one conversation (${opts.appends} appended one at a time, the last ${LATE} of them sent before all the others), ${opts.conversations} conversations, ${opts.files} files, pages of ${opts.page}`,
    );

    const contents: { hash: string; text: string }[] = [];
    for (let n = 0; n < opts.files; n++) {
      const text = fileText(n);
      const blob = await timedAnswer(() =>
        fetch(`${connection.url}/blobs`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${connection.key}`,
            "Content-Type": "text/plain",
          },
          body: text,
          signal: AbortSignal.timeout(900_000),
        }),
      );
      mustOk("uploading a file", blob, 201);
      const hash = (blob.json() as { hash: string }).hash;
      const made = await send(
        "POST",
        "/items",
        {
          type: "core.file",
          properties: { blob_ref: hash, mime_type: "text/plain" },
        },
        connection,
      );
      mustOk("creating a file", made, 201);
      files.push((made.json() as { item: { id: string } }).item.id);
      contents.push({ hash, text });
    }

    const makeConversation = async (title: string) => {
      const made = await send(
        "POST",
        "/items",
        { type: "core.conversation", properties: { title } },
        connection,
      );
      mustOk("creating a conversation", made, 201);
      return (made.json() as { item: { id: string } }).item.id;
    };
    const longTitle = "The long conversation";
    const long = await makeConversation(longTitle);
    // Reversed bulk pages expose reads that use id order instead of sent_at.
    const putBody = (numbers: number[]) =>
      JSON.stringify({
        operations: numbers.map((n) => ({
          op: "put",
          values: messageOf(n, files),
        })),
      });
    const activity = new ActivityLog();
    let written = 0;
    let writeErrors = 0;
    let failedPages = 0;
    const write = async (
      id: string,
      numbers: number[],
      label: string,
    ): Promise<number | null> => {
      const sentAt = Date.now();
      const answer = await send(
        "POST",
        `/items/${id}/tables/${TABLE}/rows`,
        putBody(numbers),
        connection,
      );
      const receivedAt = Date.now();
      const judged = judgeWrite(answer, numbers.length);
      written += judged.written.length;
      writeErrors += judged.errors;
      if (judged.errors > 0) {
        log(
          `${label}: ${judged.note ?? `${judged.errors} messages not created`}`,
        );
        if (++failedPages >= 5)
          throw new Error("five writes failed; the run stops");
        return null;
      }
      if (judged.lastActivity === null) {
        writeErrors++;
        log(`${label}: the answer names no last_activity_at`);
        return null;
      }
      const problem = activity.record(
        id,
        sentAt,
        receivedAt,
        judged.lastActivity,
      );
      if (problem !== null) {
        writeErrors++;
        log(`${label}: ${problem}`);
      }
      return answer.ms;
    };

    const bulk = opts.messages - opts.appends;
    const startedWriting = performance.now();
    for (let first = 0; first < bulk; first += opts.page) {
      const last = Math.min(first + opts.page, bulk) - 1;
      await write(
        long,
        Array.from({ length: last - first + 1 }, (_, i) => last - i),
        `messages ${first} to ${last}`,
      );
      if ((first / opts.page + 1) % 20 === 0) {
        log(`${written} messages written; load ${loadavg()[0]?.toFixed(2)}`);
      }
    }
    const fillSeconds = (performance.now() - startedWriting) / 1000;
    add(
      scalar("conversation_fill_rate", "per_s", written / fillSeconds, {
        errors: writeErrors,
        note: `${written} messages in ${fillSeconds.toFixed(1)} s, ${opts.page} to a request`,
      }),
      recordedOnly("recorded"),
    );

    // Interleaving appends exposes a listing that special-cases the long conversation.
    const small: string[] = [];
    const titles = new Map([[long, longTitle]]);
    for (let i = 0; i < opts.conversations - 1; i++) {
      const title = `Conversation ${i}`;
      const id = await makeConversation(title);
      titles.set(id, title);
      small.push(id);
    }
    const appendTimes: number[] = [];
    for (const id of small) await write(id, [0], "a first message");
    await sleep(5);
    const turn = scrambled(small.length);
    const middle = Math.floor(small.length / 2);
    // The last appends are the late messages, so the newest ids are the earliest sent.
    const appendLong = async () => {
      const sentInOrder = opts.appends - LATE;
      for (let i = 0; i < opts.appends; i++) {
        const n = i < sentInOrder ? bulk + i : sentInOrder - 1 - i;
        const ms = await write(long, [n], `append ${n}`);
        if (ms !== null) appendTimes.push(ms);
      }
    };
    for (const [position, which] of turn.entries()) {
      if (position === middle) await appendLong();
      await write(small[which] as string, [1], "a second message");
    }
    if (small.length === 0) await appendLong();
    add(
      distribution("conversation_append", "ms", appendTimes, {
        errors: writeErrors,
        note: `${appendTimes.length} single messages, the conversation growing from ${bulk} to ${opts.messages}; the last ${LATE} were sent before all the others`,
      }),
      upTo("p95 10 ms"),
    );
    add(
      scalar("conversation_messages_written", "count", written, {
        errors: writeErrors,
        note: "in every conversation",
      }),
      recordedOnly("recorded"),
    );

    const held = await rowCount(connection, long);
    if (held !== opts.messages) {
      throw new Error(
        `the conversation holds ${String(held)} messages, not ${opts.messages}`,
      );
    }
    const longItem = await send("GET", `/items/${long}`, undefined, connection);
    mustOk("reading the conversation", longItem);
    const itemActivity = (
      longItem.json() as { item: { last_activity_at: string } }
    ).item.last_activity_at;
    if (itemActivity !== activity.latest.get(long)) {
      throw new Error(
        `the conversation reads last_activity_at ${itemActivity}, its last append was answered ${activity.latest.get(long)}`,
      );
    }
    add(
      scalar("conversation_activity_advances", "count", activity.advances, {
        errors: activity.advances === 0 ? 1 : 0,
        note:
          activity.advances === 0
            ? "no write came far enough after the one before it to show last_activity_at moving on"
            : "writes to one conversation, 2 ms or more apart, that each moved last_activity_at on",
      }),
      recordedOnly("every such write moves it on"),
    );
    const memory = readServerMemory(supervisor(stateA));
    add(
      scalar("conversation_rss", "MB", memory.rssMb),
      recordedOnly("recorded"),
    );
    add(
      scalar(
        "conversation_db_size",
        "MB",
        megabytes(join(stateA, "marfa.db")) +
          megabytes(join(stateA, "marfa.db-wal")),
        {
          note: `${((megabytes(join(stateA, "marfa.db")) * 1_048_576) / opts.messages).toFixed(0)} bytes a message in the main file`,
        },
      ),
      recordedOnly("recorded"),
    );

    const latest = await readLatest(connection, long, READ_RUNS);
    const deeper = await walkMessages(
      connection,
      long,
      {
        first: inOrder - 1,
        direction: "desc",
        total: Math.min(DEEP_PAGES * WALK_LIMIT, opts.messages),
        held: opts.messages,
      },
      DEEP_PAGES,
    );
    for (const problem of deeper.problems) log(`latest, deeper: ${problem}`);
    add(
      distribution("conversation_latest_50", "ms", latest.times, {
        errors: latest.errors + deeper.errors,
        note: `${LATEST} messages, newest first by sent_at, of ${opts.messages}; the ${LATE} written last were sent first; each answer's own cursor followed to the next ${LATEST}, and ${DEEP_PAGES} pages of ${WALK_LIMIT} by cursor checked too`,
      }),
      upTo("p95 10 ms"),
    );

    const source = await walkMessages(
      connection,
      long,
      { first: -LATE, direction: "asc", total: opts.messages },
      Math.ceil(opts.messages / WALK_LIMIT) + 1,
    );
    for (const problem of source.problems) log(`source walk: ${problem}`);
    const digests = new Map([[long, source.digest]]);
    let smallErrors = 0;
    for (const id of small) {
      const walked = await walkMessages(connection, id, SMALL_PLAN, 2);
      for (const problem of walked.problems) log(`${id}: ${problem}`);
      smallErrors += walked.errors;
      digests.set(id, walked.digest);
    }
    add(
      distribution("conversation_page_by_sent_at", "ms", source.times, {
        errors: source.errors + smallErrors,
        note: `${source.times.length} pages of ${WALK_LIMIT}: every message once, in order, with the values and files written; the ${small.length} other conversations read the same way`,
      }),
      recordedOnly("recorded"),
    );

    const listed: number[] = [];
    let listErrors = 0;
    for (let run = -3; run < LIST_RUNS; run++) {
      const answer = await listConversations(connection);
      const wrong =
        answer.failed ?? judgeListing(answer.items, activity.latest);
      if (wrong !== null) {
        if (listErrors++ === 0) log(`listing: ${wrong}`);
        continue;
      }
      if (run >= 0) listed.push(answer.ms);
    }
    add(
      distribution("conversations_list_by_activity", "ms", listed, {
        errors: listErrors,
        note: `all ${opts.conversations} conversations in pages of ${LISTING_LIMIT}, latest message first; ${new Set(activity.latest.values()).size} distinct times`,
      }),
      upTo("p95 50 ms"),
    );
    log(
      `load average after the reads: ${loadavg()
        .map((n) => n.toFixed(2))
        .join(" ")}`,
    );

    const exportStarted = performance.now();
    const exported = await fetch(
      `${connection.url}/export?format=archive&type=core.conversation,core.file`,
      {
        headers: { Authorization: `Bearer ${connection.key}` },
        signal: AbortSignal.timeout(900_000),
      },
    );
    if (exported.status !== 200 || exported.body === null) {
      throw new Error(`the export answered ${exported.status}`);
    }
    await pipeline(
      Readable.fromWeb(exported.body as never),
      createWriteStream(exportFile),
    );
    add(
      scalar(
        "conversation_export",
        "s",
        (performance.now() - exportStarted) / 1000,
        { note: "the conversations and the files they name" },
      ),
      recordedOnly("recorded"),
    );
    add(
      scalar("conversation_export_size", "MB", megabytes(exportFile)),
      recordedOnly("recorded"),
    );

    started.starting(stateB);
    await bootServer({ state: stateB, env: settings });
    const restoreInto = connectionOf(stateB, "MARFA_API_KEY");
    const socket = parseEnvFile(
      readFileSync(join(stateB, "env"), "utf8"),
    ).MARFA_CONTROL_SOCKET;
    if (!socket) throw new Error(`${stateB}/env names no private socket`);
    const restoreStarted = performance.now();
    const restored = await controlRequest(socket, "/restore", {
      method: "POST",
      body: new Uint8Array(readFileSync(exportFile)),
    });
    const restoreSeconds = (performance.now() - restoreStarted) / 1000;
    if (restored.status !== 200) {
      throw new Error(
        `the restore answered ${restored.status}: ${JSON.stringify(restored.body).slice(0, 300)}`,
      );
    }
    add(
      scalar("conversation_restore", "s", restoreSeconds),
      recordedOnly("recorded"),
    );

    // The first read after the restore is the one that must already be in order.
    const afterRestore = await readLatest(restoreInto, long, READ_RUNS, 0);
    add(
      distribution(
        "conversation_latest_50_after_restore",
        "ms",
        afterRestore.times,
        {
          errors: afterRestore.errors,
          note: `the first read straight after the restore, then ${READ_RUNS - 1} more`,
        },
      ),
      upTo("p95 10 ms"),
    );
    const problems: string[] = [];
    let restoredCount = 0;
    let expectedCount = 0;
    for (const [id, title] of titles) {
      const plan = id === long ? undefined : SMALL_PLAN;
      const total = plan?.total ?? opts.messages;
      expectedCount += total;
      const label = id === long ? "the long conversation" : title;
      const item = await send("GET", `/items/${id}`, undefined, restoreInto);
      const heldTitle = ok(item)
        ? (item.json() as { item: { properties: { title?: string } } }).item
            .properties.title
        : undefined;
      if (heldTitle !== title) {
        problems.push(`${label} reads the title ${String(heldTitle)}`);
      }
      const count = await rowCount(restoreInto, id);
      if (count !== total) {
        problems.push(`${label} holds ${String(count)} messages, not ${total}`);
      }
      restoredCount += count ?? 0;
      const walked = await walkMessages(
        restoreInto,
        id,
        plan ?? { first: -LATE, direction: "asc", total, held: total },
        Math.ceil(total / WALK_LIMIT) + 1,
      );
      if (walked.errors > 0) {
        problems.push(
          `${label}: ${walked.errors} faults reading the messages back: ${walked.problems.join("; ")}`,
        );
      }
      if (walked.digest !== digests.get(id)) {
        problems.push(
          `${label}: the restored message ids differ from the source's`,
        );
      }
    }
    if (restoredCount !== expectedCount) {
      problems.push(`${restoredCount} messages came back of ${expectedCount}`);
    }
    for (const [n, id] of files.entries()) {
      const file = await send("GET", `/items/${id}`, undefined, restoreInto);
      const held = ok(file)
        ? (file.json() as { item: { properties: { blob_ref?: string } } }).item
            .properties.blob_ref
        : undefined;
      const content = contents[n] as { hash: string; text: string };
      if (held !== content.hash) {
        problems.push(
          `file ${id} reads blob ${String(held)}, not ${content.hash}`,
        );
        continue;
      }
      const bytes = await timedAnswer(() =>
        fetch(`${restoreInto.url}/blobs/${content.hash}`, {
          headers: { Authorization: `Bearer ${restoreInto.key}` },
          signal: AbortSignal.timeout(900_000),
        }),
      );
      const wrong = judgeBlob(bytes, content.text);
      if (wrong !== null) problems.push(`file ${id} ${wrong}`);
    }
    for (const problem of problems.slice(0, 20)) log(`restore: ${problem}`);
    add(
      scalar("conversation_messages_restored", "count", restoredCount, {
        errors: problems.length,
        note:
          problems.length === 0
            ? `every message of all ${titles.size} conversations read back with the values written, in order, and the ${files.length} files they name with their bytes`
            : problems.join("; ").slice(0, 400),
      }),
      recordedOnly("every message, in order, and its files"),
    );
    log(
      `load average after the restore: ${loadavg()
        .map((n) => n.toFixed(2))
        .join(" ")}`,
    );
    recorder.finish();
  } finally {
    board.stopLoad();
    for (const failure of await started.stopAll((state) =>
      stopServer({ state }),
    )) {
      log(`stopping a server: ${failure}`);
    }
    if (opts.state === null) rmSync(work, { recursive: true, force: true });
    board.report();
  }
}

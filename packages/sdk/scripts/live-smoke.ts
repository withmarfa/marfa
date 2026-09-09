/**
 * The engine's contract, run against a server that is actually running.
 *
 * The scenario suite runs against an in-process server for speed, which is
 * the right trade for a suite that runs on every push and is also the
 * reason this exists. An in-process server shares a process, a clock and a
 * filesystem with the client driving it, so the things it cannot show are
 * exactly the things a real deployment breaks on: a reconnect over a real
 * socket, a Postgres event log rather than SQLite, backpressure, and a
 * proxy in front of the whole thing.
 *
 * **A verification on one instance is a verification of that instance.**
 * So this takes the target from the environment and records the server's
 * own SHA beside the result, rather than reporting a pass with nothing
 * saying what passed.
 *
 * It creates items and edges and it removes them again on every exit path,
 * including a failing one. It creates no account, no space, no key and no
 * OAuth client: those are the four identities a verification run leaves
 * behind, and the standing rule is that a run which mints one revokes it.
 * This one mints none, which is the only version of that rule nobody can
 * forget to carry out.
 *
 *   MARFA_API_URL=https://... MARFA_API_KEY=... pnpm --filter @withmarfa/sdk smoke
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { MarfaClient } from "../src/client.js";
import { MarfaError } from "../src/errors.js";
import { openLocalStore, type LocalStore } from "../src/local/store/index.js";
import { createLocalEngine } from "../src/local/engine.js";
import { SINGLE_ACCOUNT, SINGLE_SPACE } from "../src/local/types.js";
import type { LocalEngineEvent } from "../src/local/types.js";

/**
 * A server on a real port, over a real socket.
 *
 * `MARFA_SMOKE_LOCAL=1` boots this repository's own server on SQLite and
 * points the run at it. That is the third target the ticket asks for and
 * the only one anybody can run without a deployment, and it is deliberately
 * the same code path as the hosted targets: a real listener, a real socket,
 * a real HTTP client. The one thing it does not exercise is Postgres.
 *
 * The event log has to be wired explicitly. Without it a subscription's
 * frames carry no id, the cursor never moves off its announced value, and
 * hydration looks like it works while replay is inert — a green run that
 * proves less than it appears to.
 */
async function bootLocal(): Promise<{
  url: string;
  apiKey: string;
  close: () => Promise<void>;
}> {
  const { createKeysModeFixture } = await import("../src/test-harness.js");
  const fixture = await createKeysModeFixture(undefined, { eventLog: true });
  // The fixture's `fetch` takes `(input, init)` and reads the method, the
  // headers and the body off `init` only — a bare `Request` as `input`
  // loses all three, and every call arrives as an unauthenticated GET.
  // That fails as a 401 rather than as anything naming the cause.
  const server = serve({
    fetch: (request: Request) =>
      fixture.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.method === "GET" || request.method === "HEAD"
          ? {}
          : { body: request.body, duplex: "half" }),
      }),
    port: 0,
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  if (port === 0) throw new Error("the local server did not take a port");
  return {
    url: `http://127.0.0.1:${String(port)}`,
    apiKey: fixture.spaceKey,
    close: async () => {
      await new Promise<void>((done) => {
        server.close(() => {
          done();
        });
      });
      fixture.cleanup();
    },
  };
}

const local = process.env.MARFA_SMOKE_LOCAL === "1";
const booted = local ? await bootLocal() : undefined;

const configuredUrl = booted?.url ?? process.env.MARFA_API_URL;
const configuredKey = booted?.apiKey ?? process.env.MARFA_API_KEY;

// Empty, not just absent: an unset secret reaches a workflow as the empty
// string, which would otherwise get past this and fail later with a stack
// trace instead of the sentence written for it.
if (
  configuredUrl === undefined ||
  configuredUrl === "" ||
  configuredKey === undefined ||
  configuredKey === ""
) {
  console.error(
    "MARFA_API_URL and MARFA_API_KEY are both required, or MARFA_SMOKE_LOCAL=1 to boot this repository's server on SQLite. There is no default target, because a default here would silently test the wrong instance.",
  );
  process.exit(2);
}

// Bound after the guard so nothing below has to carry `| undefined`
// through a closure, which is where the narrowing is lost.
const url: string = configuredUrl;
const apiKey: string = configuredKey;

const spaceId = process.env.MARFA_SPACE_ID ?? SINGLE_SPACE;
const accountId = process.env.MARFA_ACCOUNT_ID ?? SINGLE_ACCOUNT;

/**
 * What the server says it is.
 *
 * A build with no `version.json` reports nothing, which is normal for a
 * local boot and is recorded as such rather than as a blank. Saying
 * "unknown" is honest; leaving the field empty reads as though the
 * question was never asked.
 */
async function serverSha(): Promise<string> {
  try {
    const res = await fetch(new URL("/health", url).toString(), {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return `unreadable (HTTP ${String(res.status)})`;
    const body = (await res.json()) as {
      version?: { sha?: string };
      status?: string;
    };
    return body.version?.sha ?? "unknown (no version.json — a local build)";
  } catch (error) {
    return `unreadable (${error instanceof Error ? error.message : "unknown"})`;
  }
}

interface Check {
  readonly name: string;
  readonly run: (context: Context) => Promise<void>;
}

interface Context {
  readonly client: MarfaClient;
  readonly store: LocalStore;
  /** Anything created here is removed on every exit path. */
  readonly track: (id: string) => string;
}

function assert(condition: unknown, what: string): asserts condition {
  if (!condition) throw new Error(what);
}

const CHECKS: readonly Check[] = [
  {
    // Rules 1 to 6 over a real socket: the id the client minted is the id
    // the server holds, and the queue empties rather than merely reporting
    // that it did.
    name: "a write made with the queue cold reaches the server under its own id",
    run: async ({ client, store, track }) => {
      const note = await store.mutations.createItem({
        type: "core.note",
        properties: { body: `live smoke ${new Date().toISOString()}` },
      });
      track(note.id);
      assert((await store.outbox.count()) === 1, "the write did not queue");

      const engine = createLocalEngine({ store, client });
      await engine.drain();

      assert(
        (await store.outbox.count()) === 0,
        "the queue did not empty against a real server",
      );
      const onServer = await client.items.get(note.id);
      assert(
        onServer.id === note.id,
        "the server holds a different id than the client minted",
      );
    },
  },
  {
    // Rule 7 and rule 8 over a real stream: subscribe, then read, and see
    // a row this client never wrote.
    name: "hydration reaches a row written by somebody else",
    run: async ({ client, store, track }) => {
      const theirs = await client.items.create({
        type: "core.note",
        properties: { body: "written by another client" },
      });
      track(theirs.id);

      const engine = createLocalEngine({ store, client });
      await engine.start();
      try {
        const seen = await store.visible.getItem(theirs.id);
        assert(
          seen !== undefined,
          "hydration did not reach a row the server already held",
        );
      } finally {
        engine.stop();
      }
    },
  },
  {
    // Rule 10 against the real transaction rather than the in-process one.
    //
    // The assertion that matters is the server's own report of what it
    // did. An earlier version asserted only that the queue emptied, which
    // an engine that never collided at all satisfies just as well: drop
    // `expectedVersion` and "mine" silently overwrites "theirs", with no
    // merge, no sibling, and a green run. That is the failure this check
    // is named for, passing.
    //
    // The report is also how the sibling is identified. Inferring it from
    // a before-and-after listing would make this a scheduled job that
    // deletes rows it did not create whenever anything else writes to the
    // space inside the window — and against a shared environment that is
    // a destructive action taken on a guess.
    name: "a colliding update is settled by the server, not by the engine",
    run: async ({ client, store, track }) => {
      const note = await store.mutations.createItem({
        type: "core.note",
        properties: { body: "as written" },
      });
      track(note.id);

      const merges: Extract<LocalEngineEvent, { type: "mutation.merged" }>[] =
        [];
      const engine = createLocalEngine({ store, client });
      engine.on((event) => {
        if (event.type === "mutation.merged") merges.push(event);
      });
      await engine.drain();

      await store.mutations.updateItem(note.id, { body: "mine" });
      await client.items.update(note.id, { body: "theirs" });
      await engine.drain();

      assert(
        (await store.outbox.count()) === 0,
        "the update did not settle; the server may not resolve conflicts",
      );

      const merged = merges[0];
      // Tracked before anything can throw. An assertion between the write
      // and the tracking is how the one row whose id cannot be known in
      // advance gets left behind on exactly the runs that fail.
      if (merged?.conflictedCopyId !== undefined)
        track(merged.conflictedCopyId);

      assert(
        merged !== undefined,
        "the server reported no merge, so nothing collided — the update overwrote rather than merging",
      );
      assert(
        merged.fields.includes("body"),
        `the merge did not name body as the collided field: ${JSON.stringify(merged.fields)}`,
      );
      assert(
        merged.strategy.body === "keep_both_copies",
        `body resolved by ${String(merged.strategy.body)} rather than keep_both_copies`,
      );
      // The sibling the policy called for, named by the only thing that
      // names it, and tracked so it leaves with everything else.
      assert(
        merged.conflictedCopyId !== undefined,
        "keep_both_copies reported no sibling, so the losing value was dropped",
      );
    },
  },
  {
    // Rule 2 over a real socket, which is the only place it can be shown:
    // the write lands, its answer is lost on the way back, and the replay
    // carries the key the mutation was written with. The server answers
    // from what it kept rather than failing against the row it already
    // removed.
    //
    // The response is dropped rather than the request, because a request
    // that never arrives proves nothing about idempotency — it is just an
    // offline pass. This drops exactly one DELETE answer, after the server
    // has committed it.
    name: "a delete whose answer was lost replays as a no-op",
    run: async ({ client, store, track }) => {
      const note = await store.mutations.createItem({
        type: "core.note",
        properties: { body: "to be removed" },
      });
      track(note.id);
      await createLocalEngine({ store, client }).drain();

      let dropped = false;
      let droppedStatus = 0;
      const losing = new MarfaClient({
        url,
        apiKey,
        fetch: async (input, init) => {
          const response = await globalThis.fetch(input, init);
          const method = (init?.method ?? "GET").toUpperCase();
          if (!dropped && method === "DELETE") {
            dropped = true;
            // Recorded before the body is discarded, because the whole
            // point of this check is that the server ANSWERED and the
            // answer was lost. Moving this throw above the `await` turns
            // it into an offline pass, and without this record nothing
            // would notice.
            droppedStatus = response.status;
            await response.body?.cancel();
            throw new TypeError("fetch failed");
          }
          return response;
        },
      });

      await store.mutations.deleteItem(note.id);
      await createLocalEngine({ store, client: losing }).drain();
      assert(dropped, "no DELETE answer was dropped, so nothing was replayed");
      assert(
        droppedStatus >= 200 && droppedStatus < 300,
        `the dropped DELETE answered ${String(droppedStatus)}, so the write may never have landed and this proves nothing about a replay`,
      );
      assert(
        (await store.outbox.count()) === 1,
        "a lost answer should leave the delete queued for a replay",
      );

      await createLocalEngine({ store, client }).drain();
      assert(
        (await store.outbox.count()) === 0,
        "the replayed delete did not settle",
      );
      assert(
        (await store.deadLetters.list()).length === 0,
        "the replayed delete dead-lettered instead of repeating as a no-op",
      );
    },
  },
];

async function main(): Promise<number> {
  const sha = await serverSha();
  console.log(`target : ${url}`);
  console.log(`server : ${sha}`);
  // A server with no spaces has no id to give, and the sentinel for that
  // is the empty string. Printing it bare advertises a field and leaves it
  // blank, which reads as something failing to resolve.
  console.log(
    `space  : ${spaceId === "" ? "(single-space instance)" : spaceId}`,
  );
  console.log("");

  const client = new MarfaClient({ url, apiKey });
  const created: string[] = [];
  let failures = 0;

  for (const check of CHECKS) {
    const dir = mkdtempSync(join(tmpdir(), "marfa-live-smoke-"));
    let store: LocalStore | undefined;
    try {
      store = await openLocalStore({
        path: join(dir, "store.db"),
        identity: { origin: url, spaceId, accountId },
      });
      await check.run({
        client,
        store,
        track: (id) => {
          created.push(id);
          return id;
        },
      });
      console.log(`  ok    ${check.name}`);
    } catch (error) {
      failures += 1;
      console.log(`  FAIL  ${check.name}`);
      console.log(
        `        ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Every exit path, including a failing one. A run that leaves rows behind
  // makes the next run's failure someone else's puzzle.
  let leaked = 0;
  for (const id of created) {
    try {
      await client.items.delete(id);
    } catch (error) {
      // Already gone is the ordinary case for a row a check removed, and a
      // 404 is how the server says so. Read the typed status rather than
      // the prose: matching on the message means a reworded error turns
      // every successful cleanup into a reported leak.
      const status = error instanceof MarfaError ? error.status : 0;
      if (status !== 404) {
        leaked += 1;
        console.log(
          `  left behind: ${id} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
  }

  console.log("");
  console.log(
    `${String(CHECKS.length - failures)}/${String(CHECKS.length)} green against ${sha}`,
  );
  if (leaked > 0) {
    console.log(
      `${String(leaked)} row(s) could not be removed and need a look — a run owns what it creates.`,
    );
  }
  return failures > 0 || leaked > 0 ? 1 : 0;
}

main()
  .then(async (code) => {
    await booted?.close();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await booted?.close();
    process.exit(1);
  });

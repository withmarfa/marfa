import { randomUUID } from "node:crypto";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { trackItem, trackEdge } from "../../utils/setup.js";
import {
  collectUntil,
  withStream,
  MUTATION_EVENT_NAMES,
} from "../../utils/stream.js";
import type { SseEvent } from "../../utils/sse.js";

/**
 * Why these probes read behavior rather than a status code or a spec.
 *
 * The server drops query keys it does not declare and answers 200. Measured
 * against a fifty-row listing: a nonsense key returns the same fifty rows as
 * no filter at all, and so does a filter parameter the server does not
 * implement, while a filter it does implement returns zero rows for an
 * impossible bound. There is no status, no warning and no field in the
 * response that separates "this filter matched everything" from "this filter
 * does not exist".
 *
 * So a status probe is a false-positive machine for every rule that turns on a
 * query parameter: it reports `present` for a parameter that provably does
 * nothing, the suite runs the test, and the red that follows describes a
 * feature gap as though it were a regression. That is the expensive direction,
 * and it is why nobody should "simplify" these into status checks. If you are
 * reading this because you were about to: the check you want already exists
 * below as the control leg, and deleting the rest deletes the part that works.
 *
 * The document at `/openapi.json` is the tempting middle option and fails for
 * a different reason. It is generated from route shapes, so it is truthful
 * about shape and silent about behavior: the `state` parameter carries no enum
 * at all, so the spec cannot say whether `state=any` is accepted, and the item
 * listing declares `updated_after` whether or not the handler narrows anything
 * by it. Most of the rules here are behaviors.
 *
 * Every probe therefore makes an observation that differs between present and
 * absent, and carries a control that proves the probe itself discriminates. A
 * probe whose control fails does not guess: it throws, and the run goes red.
 * That is what keeps an `absent` honest — it can only ever mean "the probe ran
 * and answered absent", never "the probe broke".
 */

export type RuleKey =
  | "idempotencyKeys"
  | "updatedAfter"
  | "edgeUpdatedAfter"
  | "itemPurgedEvent"
  | "edgeVersion"
  | "edgeEventsUnderFilter"
  | "announcedCursor"
  | "stateAny"
  | "serverSideMerge";

export const RULE_KEYS: RuleKey[] = [
  "idempotencyKeys",
  "updatedAfter",
  "edgeUpdatedAfter",
  "itemPurgedEvent",
  "edgeVersion",
  "edgeEventsUnderFilter",
  "announcedCursor",
  "stateAny",
  "serverSideMerge",
];

export interface RuleFinding {
  present: boolean;
  /** What was observed, in enough detail to argue with. */
  evidence: string;
}

export type SyncCapabilities = Record<RuleKey, RuleFinding>;

/**
 * A probe that could not tell present from absent.
 *
 * Thrown, never returned. An indeterminate probe that degraded to `absent`
 * would report a rule missing that it never managed to look for, and the test
 * that requires the rule would then fail naming the server rather than the
 * probe.
 */
export class IndeterminateProbe extends Error {
  constructor(rule: RuleKey, detail: string) {
    super(
      `capability probe for "${rule}" could not tell present from absent: ${detail}. ` +
        `This is a broken probe, not an absent feature; the run goes red until the probe is fixed.`,
    );
    this.name = "IndeterminateProbe";
  }
}

const IMPOSSIBLE_FUTURE = "2099-01-01T00:00:00.000Z";
const NONSENSE_KEY = "zzz_not_a_parameter";

let cached: Promise<SyncCapabilities> | undefined;

/**
 * Probe every rule once per file and cache the answer.
 *
 * Cached because the probes write: three of them create rows, and repeating
 * that per file would multiply a dozen requests by however many files the
 * project grows. The rows belong to whichever file probed first and are torn
 * down with that file, which is fine — the answer outlives them.
 */
export function detectSyncCapabilities(args: {
  client: MarfaClient;
  ctx: TestContext;
  apiUrl: string;
  apiKey: string;
}): Promise<SyncCapabilities> {
  cached ??= runProbes(args);
  return cached;
}

async function runProbes(args: {
  client: MarfaClient;
  ctx: TestContext;
  apiUrl: string;
  apiKey: string;
}): Promise<SyncCapabilities> {
  const findings = {
    idempotencyKeys: await probeIdempotencyKeys(args),
    updatedAfter: await probeUpdatedAfter(args),
    edgeUpdatedAfter: await probeEdgeUpdatedAfter(args),
    edgeVersion: await probeEdgeVersion(args),
    itemPurgedEvent: await probeItemPurgedEvent(args),
    edgeEventsUnderFilter: await probeEdgeEventsUnderFilter(args),
    announcedCursor: await probeAnnouncedCursor(args),
    stateAny: await probeStateAny(args),
    serverSideMerge: await probeServerSideMerge(args),
  } satisfies SyncCapabilities;

  // Printed so the run log carries every observation, not only the verdict.
  console.log(formatCapabilities(findings));
  return findings;
}

/**
 * A create under an idempotency key, with the two facts a repeat turns on.
 *
 * `Idempotency-Replayed` is read here for the evidence, not the verdict; see the
 * probe below for why it is evidence rather than a discriminator.
 */
async function keyedCreate(
  client: MarfaClient,
  ctx: TestContext,
  key: string,
  body: string,
): Promise<{
  ok: boolean;
  status: number;
  id?: string;
  errorCode?: string;
  error: unknown;
  replayed: boolean;
}> {
  const res = await client.rawRequest<{
    item: { id: string; properties: Record<string, unknown> };
  }>("/items", {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: { type: "core.note", source: ctx.source, properties: { body } },
  });
  if (res.ok) trackItem(ctx, res.data.item.id);
  return {
    ok: res.ok,
    status: res.status,
    id: res.ok ? res.data.item.id : undefined,
    errorCode: res.error?.error?.code,
    error: res.error,
    replayed: res.headers.get("Idempotency-Replayed") === "true",
  };
}

/**
 * Does the server read `Idempotency-Key`, and is a repeat answered from a store?
 *
 * **The door has three answers, not two.** Reading it as two — two creates
 * under one key with different bodies, a repeated id taken as proof the key
 * was honored — leaves no room for the refusal a key naming two different
 * requests earns, so the probe throws against a server that implements the
 * rule. **Do not reduce it to a two-valued reading.** The three answers are:
 *
 *   - **honored** — the key is read and a true repeat gets the stored result;
 *   - **ignored** — the key is dropped and every send writes another row;
 *   - **reuse-refused** — the key is read, and it names a *different* request
 *     than the one it was minted for, which is a client error rather than a
 *     retry.
 *
 * The third is the discriminator, and that inversion is the point: the
 * refusal is not an obstacle to probing, it is the cleanest evidence
 * available. A key is minted per mutation, so one key naming two requests is
 * a caller bug the server has to refuse — and **only a server that read the
 * key and stored a digest of the request against it can produce that
 * refusal.** The confounders worth worrying about cannot reach it: a
 * natural-key match and a content dedupe both collapse writes that are *the
 * same*, and this refusal fires on writes that *differ*. There is nothing for
 * a keyless server to refuse.
 *
 * So the legs are:
 *
 *   1. **Reuse.** Two different bodies under one key. A refusal, or a replay
 *      of the first, means the key was read; two ids mean it was not, and
 *      that is `absent` with no control needed — neither an honoring server
 *      nor a dedupe writes two rows for one key.
 *   2. **Replay.** Two byte-identical creates under a second key, which is
 *      what an offline queue actually resends. One id means no second write
 *      happened, since a re-run of a create with no caller-supplied id would
 *      mint a fresh one.
 *   3. **The control**, and it is leg 2 that needs it. The same content again
 *      under a *third* key has to produce a new row. If it does not, this
 *      door collapses on content and leg 2's single id says nothing about the
 *      key — so the probe throws rather than reporting a rule it could not
 *      see.
 *
 * **On `Idempotency-Replayed`.** The server sends it on a replayed response
 * and `idempotency.test.ts` asserts it. The probe still discriminates on the
 * reuse refusal, because that alone separates the three answers a door can
 * give; the header is recorded in the evidence beside the verdict.
 */
async function probeIdempotencyKeys(args: {
  client: MarfaClient;
  ctx: TestContext;
}): Promise<RuleFinding> {
  const { client, ctx } = args;

  // Leg 1 — the reuse leg. Two different requests, one key.
  const reuseKey = `probe-reuse-${randomUUID()}`;
  const reuseFirst = await keyedCreate(client, ctx, reuseKey, "probe-reuse-a");
  if (!reuseFirst.ok) {
    throw new IndeterminateProbe(
      "idempotencyKeys",
      `the first create failed outright (${reuseFirst.status} ${JSON.stringify(reuseFirst.error)})`,
    );
  }
  const reuseSecond = await keyedCreate(client, ctx, reuseKey, "probe-reuse-b");

  let readsTheKey: string;
  if (reuseSecond.ok) {
    if (reuseSecond.id !== reuseFirst.id) {
      // Neither an honoring server nor a content dedupe produces this: one
      // key naming two requests is either refused or replayed, and a dedupe
      // has nothing to collapse because the bodies differ. Two rows means
      // the header was dropped.
      return {
        present: false,
        evidence: `two different creates under one Idempotency-Key returned two ids (${reuseFirst.id}, ${reuseSecond.id}), so the header is being dropped`,
      };
    }
    // The key was read — a keyless door cannot collapse two different
    // bodies — but this answer serves the reuse rather than refusing it. The
    // rule is still present; the deviation belongs in a test's assertion
    // rather than in the probe's verdict.
    readsTheKey = `a second, different request under one key was answered with the first row (${reuseFirst.id}) rather than refused`;
  } else if (reuseSecond.errorCode === "idempotency_key_reused") {
    readsTheKey = `a second, different request under one key was refused ${reuseSecond.status} idempotency_key_reused`;
  } else {
    throw new IndeterminateProbe(
      "idempotencyKeys",
      `a second, different request under one key was refused ${reuseSecond.status} ${JSON.stringify(reuseSecond.error)}, which is neither the documented \`idempotency_key_reused\` nor an outcome a server ignoring the header can produce`,
    );
  }

  // Leg 2 — the replay leg. The same request twice, as a queue resends it.
  const replayKey = `probe-replay-${randomUUID()}`;
  const replayBody = `probe-replay-${randomUUID()}`;
  const replayFirst = await keyedCreate(client, ctx, replayKey, replayBody);
  if (!replayFirst.ok) {
    throw new IndeterminateProbe(
      "idempotencyKeys",
      `the first of two identical creates failed outright (${replayFirst.status} ${JSON.stringify(replayFirst.error)})`,
    );
  }
  const replaySecond = await keyedCreate(client, ctx, replayKey, replayBody);
  if (!replaySecond.ok) {
    throw new IndeterminateProbe(
      "idempotencyKeys",
      `a byte-identical repeat under the key it was minted for was refused (${replaySecond.status} ${JSON.stringify(replaySecond.error)}); ${readsTheKey}, so the key is read, but a repeat this server cannot answer is a rule this probe cannot characterize`,
    );
  }
  if (replaySecond.id !== replayFirst.id) {
    throw new IndeterminateProbe(
      "idempotencyKeys",
      `${readsTheKey}, yet two identical creates under one key returned two ids (${replayFirst.id}, ${replaySecond.id}) — the header is read on one path and dropped on another`,
    );
  }

  // Leg 3 — the control for leg 2. Same content, fresh key, must be a new row.
  const controlKey = `probe-control-${randomUUID()}`;
  const control = await keyedCreate(client, ctx, controlKey, replayBody);
  if (!control.ok) {
    throw new IndeterminateProbe(
      "idempotencyKeys",
      `the control create under a fresh key failed outright (${control.status} ${JSON.stringify(control.error)})`,
    );
  }
  if (control.id === replayFirst.id) {
    throw new IndeterminateProbe(
      "idempotencyKeys",
      `the same content under a different key returned the same row (${control.id}), so this door collapses writes on their content and the repeated id in the replay leg says nothing about the key`,
    );
  }

  return {
    present: true,
    evidence:
      `${readsTheKey}; an identical repeat returned the first id (${replayFirst.id}) ` +
      `${replaySecond.replayed ? "and carried Idempotency-Replayed" : "without an Idempotency-Replayed header"}, ` +
      `while the same content under a fresh key wrote a new row (${control.id})`,
  };
}

/**
 * Does `updated_after` narrow a listing, or is it being dropped?
 *
 * Three reads that differ only in the query string: none, an impossible future
 * bound, and a key the server certainly does not declare. Present means the
 * future bound returns strictly fewer rows than no filter *and* the nonsense
 * key returns the same as no filter.
 *
 * The nonsense leg does double duty. It proves the probe discriminates, and it
 * detects a server that refuses unknown keys — at which point a status
 * genuinely does separate the two cases and the probe switches to reading one,
 * so a door that refuses more does not break the probe.
 */
async function probeUpdatedAfter(args: {
  client: MarfaClient;
  ctx: TestContext;
}): Promise<RuleFinding> {
  const { client, ctx } = args;
  const seed = await client.createItem({
    type: "core.note",
    source: ctx.source,
    properties: { body: "probe-updated-after" },
  });
  if (!seed.ok) {
    throw new IndeterminateProbe(
      "updatedAfter",
      `could not seed a row to filter (${seed.status})`,
    );
  }
  trackItem(ctx, seed.data.item.id);

  const scope = `source=${encodeURIComponent(ctx.source)}&limit=50`;
  const bare = await countRows(client, `/items?${scope}`);
  const control = await countRows(
    client,
    `/items?${scope}&${NONSENSE_KEY}=${IMPOSSIBLE_FUTURE}`,
  );
  const probe = await countRows(
    client,
    `/items?${scope}&updated_after=${IMPOSSIBLE_FUTURE}`,
  );

  // `<= 0` rather than `=== 0`, because a count of -1 means the page could not
  // be read at all — a refusal, or a listing envelope this probe is reading
  // the wrong key out of. Read as a row count, that arm reports "the filter
  // changed nothing" against every server, which is the false negative this
  // whole file is built to make impossible: the rule's tests would then fail
  // naming the server for a probe that never looked.
  if (bare.rows <= 0) {
    throw new IndeterminateProbe(
      "updatedAfter",
      `the unfiltered read returned ${bare.rows} rows (status ${bare.status}) even after seeding one, so a filter that removes them cannot be told from one that does nothing`,
    );
  }

  // This server refuses unknown keys, so a status separates the two cases on
  // its own, which is a better probe than a row count.
  if (control.status === 400) {
    if (probe.status === 400) {
      return {
        present: false,
        evidence: `the server refuses unknown query keys (control key -> 400) and refuses updated_after too (-> 400)`,
      };
    }
    if (probe.status === 200) {
      return {
        present: true,
        evidence: `the server refuses unknown query keys (control key -> 400) and accepts updated_after (-> 200)`,
      };
    }
    throw new IndeterminateProbe(
      "updatedAfter",
      `the control key was refused with 400 but updated_after answered ${probe.status}, which is neither acceptance nor refusal`,
    );
  }

  if (control.rows !== bare.rows) {
    throw new IndeterminateProbe(
      "updatedAfter",
      `a key the server does not declare changed the row count (${bare.rows} -> ${control.rows}), so a row-count difference proves nothing about updated_after`,
    );
  }
  if (probe.rows < bare.rows) {
    return {
      present: true,
      evidence: `updated_after=${IMPOSSIBLE_FUTURE} narrowed the listing from ${bare.rows} rows to ${probe.rows}, while a nonsense key left it at ${control.rows}`,
    };
  }
  return {
    present: false,
    evidence: `updated_after=${IMPOSSIBLE_FUTURE} returned the same ${probe.rows} rows as no filter, and so did the nonsense control key — the parameter is being dropped`,
  };
}

async function countRows(
  client: MarfaClient,
  path: string,
): Promise<{ rows: number; status: number }> {
  const response = await client.rawRequest<{ data?: unknown[] }>(path);
  if (!response.ok) return { rows: -1, status: response.status };
  return { rows: response.data.data?.length ?? -1, status: response.status };
}

/**
 * The same question as `updatedAfter`, asked of the edge listing.
 *
 * Asked separately because the answer can differ. A catch-up that reads items
 * incrementally and edges not at all is the shape a server acquires by
 * implementing the obvious half: the rows all arrive, the graph between them
 * does not, and a client reconnecting believes it is current while holding a
 * stale set of edges. Nothing distinguishes that from a dataset whose edges
 * genuinely did not change.
 *
 * The bound is impossible rather than merely narrow, so `present` means the
 * listing came back empty rather than merely smaller. `/edges` takes no
 * `source` filter, so it returns the rows other files in the run wrote too,
 * and a "fewer than before" comparison would be reading their churn.
 */
async function probeEdgeUpdatedAfter(args: {
  client: MarfaClient;
  ctx: TestContext;
}): Promise<RuleFinding> {
  const { client, ctx } = args;
  const [source, target] = await Promise.all([
    client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "probe-edge-updated-after-src" },
    }),
    client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "probe-edge-updated-after-tgt" },
    }),
  ]);
  if (!source.ok || !target.ok) {
    throw new IndeterminateProbe(
      "edgeUpdatedAfter",
      `could not create the two items an edge needs (${source.status}, ${target.status})`,
    );
  }
  trackItem(ctx, source.data.item.id);
  trackItem(ctx, target.data.item.id);
  const seed = await client.createEdge({
    source_id: source.data.item.id,
    target_id: target.data.item.id,
    edge_type: "about",
  });
  if (!seed.ok) {
    throw new IndeterminateProbe(
      "edgeUpdatedAfter",
      `could not seed an edge to filter (${seed.status} ${JSON.stringify(seed.error)})`,
    );
  }
  trackEdge(ctx, seed.data.edge.id);

  const bare = await countEdges(client, "/edges?limit=50");
  const control = await countEdges(
    client,
    `/edges?limit=50&${NONSENSE_KEY}=${IMPOSSIBLE_FUTURE}`,
  );
  const probe = await countEdges(
    client,
    `/edges?limit=50&updated_after=${IMPOSSIBLE_FUTURE}`,
  );

  if (bare.rows <= 0) {
    throw new IndeterminateProbe(
      "edgeUpdatedAfter",
      `the unfiltered edge listing returned ${bare.rows} rows (status ${bare.status}) even after seeding one, so a filter that removes them cannot be told from one that does nothing`,
    );
  }
  if (control.status === 400) {
    if (probe.status === 400) {
      return {
        present: false,
        evidence: `the server refuses unknown query keys on /edges (control key -> 400) and refuses updated_after too (-> 400)`,
      };
    }
    if (probe.status === 200) {
      return {
        present: true,
        evidence: `the server refuses unknown query keys on /edges (control key -> 400) and accepts updated_after (-> 200)`,
      };
    }
    throw new IndeterminateProbe(
      "edgeUpdatedAfter",
      `the control key was refused with 400 but updated_after answered ${probe.status}, which is neither acceptance nor refusal`,
    );
  }
  if (control.rows <= 0) {
    throw new IndeterminateProbe(
      "edgeUpdatedAfter",
      `a key the server does not declare emptied the edge listing (${bare.rows} -> ${control.rows}), so an empty result proves nothing about updated_after`,
    );
  }
  if (probe.rows === 0) {
    return {
      present: true,
      evidence: `updated_after=${IMPOSSIBLE_FUTURE} emptied the edge listing (${bare.rows} rows without it, ${control.rows} with a nonsense key)`,
    };
  }
  return {
    present: false,
    evidence: `updated_after=${IMPOSSIBLE_FUTURE} still returned ${probe.rows} edges, and so did the nonsense control key (${control.rows}) — the parameter is being dropped, so a reconnecting client's graph is never caught up`,
  };
}

/**
 * `GET /edges` pages under `data`, the same key `GET /items` uses. Named here
 * once rather than at each call site, because reading the wrong key returns
 * `undefined` and looks exactly like an empty page, which reports `absent`
 * against a server that implements the parameter.
 */
async function countEdges(
  client: MarfaClient,
  path: string,
): Promise<{ rows: number; status: number }> {
  const response = await client.rawRequest<{ data?: unknown[] }>(path);
  if (!response.ok) return { rows: -1, status: response.status };
  return { rows: response.data.data?.length ?? -1, status: response.status };
}

/**
 * Does the server resolve a conflict inside its own transaction?
 *
 * The half that discriminates is `keep_both_copies`, not the merge. Two
 * clients editing *different* fields already merge, and that is covered in
 * the correctness suite, so probing it would report `present` against every
 * server ever shipped. Two clients editing a field the type says to keep both
 * copies of is what changes: without the rule the server answers 409 and the
 * client creates the sibling, and under it the server creates the sibling in
 * the same transaction as the write.
 *
 * `conflict=auto` is the parameter the rule turns on. An unknown query key is
 * dropped, so a server without the rule sees a plain stale update and answers
 * 409, which is exactly the `absent` reading — the silence costs nothing here.
 * A server that lands the rule under a different parameter name reports
 * `absent`, and the test that requires the rule then fails and names it.
 *
 * The control is the same request without the parameter. It has to be refused,
 * or the collision was not a collision and a 200 from the probe would mean
 * nothing.
 */
async function probeServerSideMerge(args: {
  client: MarfaClient;
  ctx: TestContext;
}): Promise<RuleFinding> {
  const { client, ctx } = args;
  const seed = await client.createItem({
    type: "core.note",
    source: ctx.source,
    properties: { title: "probe-merge", body: "probe-merge-base" },
  });
  if (!seed.ok) {
    throw new IndeterminateProbe(
      "serverSideMerge",
      `could not seed the item to conflict on (${seed.status})`,
    );
  }
  const id = seed.data.item.id;
  trackItem(ctx, id);
  const base = seed.data.item.version;

  const winner = await client.updateItem(id, {
    properties: { body: "probe-merge-winner" },
    version: base,
  });
  if (!winner.ok) {
    throw new IndeterminateProbe(
      "serverSideMerge",
      `the first writer's update failed (${winner.status}), so there is no collision to resolve`,
    );
  }

  // The control, sent first: the same stale write with no parameter has to be
  // refused, or `body` is not a colliding field on this server and the probe
  // below would report `present` for the wrong reason.
  const bare = await client.updateItem(id, {
    properties: { body: "probe-merge-loser" },
    version: base,
  });
  if (bare.status !== 409) {
    throw new IndeterminateProbe(
      "serverSideMerge",
      `a stale update against a keep-both field answered ${bare.status} rather than 409, so this server has no collision for the rule to resolve`,
    );
  }

  const auto = await client.rawRequest<{ item?: { id?: string } }>(
    `/items/${id}?conflict=auto`,
    {
      method: "PATCH",
      body: { properties: { body: "probe-merge-loser" }, version: base },
    },
  );
  if (auto.status === 409) {
    return {
      present: false,
      evidence: `a stale update sent with conflict=auto was refused 409 exactly as the same request without it, so the parameter is being dropped and the client still owns the resolution`,
    };
  }
  if (auto.ok) {
    // The rule creates a sibling in the same transaction. Left untracked it
    // outlives the run, and it would do so only on the servers that implement
    // the rule — a leak that cannot appear until the day the feature ships,
    // which is the worst time to discover one. The sweep by source owns it
    // whether or not this server names it in the envelope.
    await trackSourceScopedItems(args);
    return {
      present: true,
      evidence: `a stale update sent with conflict=auto was applied (200) where the same request without it was refused 409`,
    };
  }
  throw new IndeterminateProbe(
    "serverSideMerge",
    `conflict=auto answered ${auto.status} (${JSON.stringify(auto.error)}), which is neither the 409 of a server without the rule nor the success of one with it`,
  );
}

/**
 * Is `state=any` accepted?
 *
 * The one rule here a status genuinely settles, and it is worth saying why so
 * the exception does not get read as permission to status-probe the rest.
 * `state` is not an undeclared key the validator drops: it is a declared
 * parameter with a closed set of values, so an unsupported value is refused
 * rather than ignored — `state=bogus` answers 400 `validation_error` naming
 * the value. That refusal is the discriminator, and the nonsense value is the
 * control that proves the endpoint refuses at all rather than accepting
 * anything.
 */
async function probeStateAny(args: {
  client: MarfaClient;
}): Promise<RuleFinding> {
  const { client } = args;
  const control = await client.rawRequest<unknown>(
    "/items?limit=1&state=zzz_not_a_state",
  );
  if (control.status !== 400) {
    throw new IndeterminateProbe(
      "stateAny",
      `a meaningless lifecycle state answered ${control.status} rather than 400, so a refusal cannot be read as "this value is unsupported"`,
    );
  }
  const probe = await client.rawRequest<unknown>("/items?limit=1&state=any");
  if (probe.ok) {
    return {
      present: true,
      evidence: `state=any is accepted while a meaningless state is refused with 400`,
    };
  }
  if (probe.status === 400) {
    return {
      present: false,
      evidence: `state=any is refused with 400, exactly as a meaningless state is: ${JSON.stringify(probe.error)}`,
    };
  }
  throw new IndeterminateProbe(
    "stateAny",
    `state=any answered ${probe.status}, which is neither acceptance nor the refusal a meaningless value gets`,
  );
}

/**
 * Does an edge carry a version?
 *
 * The control is that the response parsed as an edge at all: a create that
 * answered with something carrying no `id` would report "no version" for the
 * wrong reason.
 */
async function probeEdgeVersion(args: {
  client: MarfaClient;
  ctx: TestContext;
}): Promise<RuleFinding> {
  const { client, ctx } = args;
  const [source, target] = await Promise.all([
    client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "probe-edge-src" },
    }),
    client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "probe-edge-tgt" },
    }),
  ]);
  if (!source.ok || !target.ok) {
    throw new IndeterminateProbe(
      "edgeVersion",
      `could not create the two items an edge needs (${source.status}, ${target.status})`,
    );
  }
  trackItem(ctx, source.data.item.id);
  trackItem(ctx, target.data.item.id);

  const edge = await client.createEdge({
    source_id: source.data.item.id,
    target_id: target.data.item.id,
    edge_type: "about",
  });
  if (!edge.ok) {
    throw new IndeterminateProbe(
      "edgeVersion",
      `the edge create failed (${edge.status} ${JSON.stringify(edge.error)})`,
    );
  }
  trackEdge(ctx, edge.data.edge.id);

  const payload = edge.data.edge as unknown as Record<string, unknown>;
  if (typeof payload.id !== "string") {
    throw new IndeterminateProbe(
      "edgeVersion",
      `the create answered 200 with no edge id, so the payload was not an edge`,
    );
  }
  if (typeof payload.version === "number") {
    return {
      present: true,
      evidence: `a created edge carries version ${payload.version}`,
    };
  }
  return {
    present: false,
    evidence: `a created edge carries no version field (keys: ${Object.keys(payload).join(", ")})`,
  };
}

/**
 * Does purging an item announce itself?
 *
 * The control is the soft delete on the same stream. `item.deleted` arriving
 * and `item.purged` not arriving is a finding; neither arriving says only that
 * the subscription was not working, which is a different thing and must not be
 * recorded as an absent rule.
 */
async function probeItemPurgedEvent(args: {
  client: MarfaClient;
  ctx: TestContext;
  apiUrl: string;
  apiKey: string;
}): Promise<RuleFinding> {
  const { client, ctx, apiUrl, apiKey } = args;
  return withStream(apiUrl, apiKey, {}, async (stream) => {
    await new Promise((r) => setTimeout(r, 250));
    const created = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "probe-purge" },
    });
    if (!created.ok) {
      throw new IndeterminateProbe(
        "itemPurgedEvent",
        `could not create the item to purge (${created.status})`,
      );
    }
    const id = created.data.item.id;
    // Tracked in case anything below throws; the purge removes it, and
    // teardown tolerates a row that is already gone.
    trackItem(ctx, id);

    const deleted = await client.deleteItem(id);
    const purged = await client.purgeItem(id);
    if (!deleted.ok || !purged.ok) {
      throw new IndeterminateProbe(
        "itemPurgedEvent",
        `delete/purge did not succeed (${deleted.status}/${purged.status}), so the stream had nothing to announce`,
      );
    }

    const saw = (events: SseEvent[], name: string) =>
      events.some(
        (e) =>
          e.event === name &&
          (e.data as { item?: { id?: string } })?.item?.id === id,
      );

    // Waits for a sentinel written after the purge rather than for a quiet
    // window, because `absent` here fails every test that requires the rule
    // and a late frame would do that for the wrong reason. The sentinel is an
    // item, like the frame it is ruling out: items reach a subscriber in
    // publish order, so once the sentinel has arrived an `item.purged` that
    // was going to come has come. It doubles as the control the window could
    // not provide — a stream that never delivers it fails the probe rather
    // than answering it.
    const sentinel = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "probe-purge-sentinel" },
    });
    if (!sentinel.ok) {
      throw new IndeterminateProbe(
        "itemPurgedEvent",
        `could not write the sentinel this probe waits for (${sentinel.status})`,
      );
    }
    trackItem(ctx, sentinel.data.item.id);
    const { events: settled } = await collectUntil(
      stream,
      (evts) =>
        evts.some(
          (e) =>
            (e.data as { item?: { id?: string } })?.item?.id ===
            sentinel.data.item.id,
        ),
      `the sentinel written after purging ${id} to reach the stream`,
    );

    if (!saw(settled, "item.deleted")) {
      throw new IndeterminateProbe(
        "itemPurgedEvent",
        `the stream never delivered item.deleted for ${id} either, so it was not carrying this dataset's events`,
      );
    }
    if (saw(settled, "item.purged")) {
      return {
        present: true,
        evidence: `purging ${id} delivered item.purged on a live subscription`,
      };
    }
    return {
      present: false,
      evidence: `purging ${id} delivered item.deleted but no item.purged, so a client offline across the purge is never told the row is gone`,
    };
  });
}

/**
 * Does a type-filtered stream carry edge events?
 *
 * The control is an item event for the same write on the same filtered
 * stream. A filter that admits the notes but drops the edge between them is
 * the finding; a stream that carries neither is a broken subscription.
 */
async function probeEdgeEventsUnderFilter(args: {
  client: MarfaClient;
  ctx: TestContext;
  apiUrl: string;
  apiKey: string;
}): Promise<RuleFinding> {
  const { client, ctx, apiUrl, apiKey } = args;
  return withStream(
    apiUrl,
    apiKey,
    { query: [["type", "core.note"]] },
    async (stream) => {
      await new Promise((r) => setTimeout(r, 250));
      const source = await client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: "probe-filter-src" },
      });
      const target = await client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: "probe-filter-tgt" },
      });
      if (!source.ok || !target.ok) {
        throw new IndeterminateProbe(
          "edgeEventsUnderFilter",
          `could not create the two notes (${source.status}, ${target.status})`,
        );
      }
      trackItem(ctx, source.data.item.id);
      trackItem(ctx, target.data.item.id);
      const edge = await client.createEdge({
        source_id: source.data.item.id,
        target_id: target.data.item.id,
        edge_type: "about",
      });
      if (!edge.ok) {
        throw new IndeterminateProbe(
          "edgeEventsUnderFilter",
          `the edge create failed (${edge.status})`,
        );
      }
      trackEdge(ctx, edge.data.edge.id);
      const edgeId = edge.data.edge.id;

      // A sentinel note written after the edge: the stream delivers both
      // kinds in id order, so its frame arriving settles whether the edge's
      // frame came, and a note passes the filter on a server that withholds
      // edges, so the probe reports `absent` rather than hanging on a
      // sentinel edge the server would withhold too.
      const sentinel = await client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: "probe-filter-sentinel" },
      });
      if (!sentinel.ok) {
        throw new IndeterminateProbe(
          "edgeEventsUnderFilter",
          `the sentinel note create failed (${sentinel.status})`,
        );
      }
      trackItem(ctx, sentinel.data.item.id);
      const { events: settled } = await collectUntil(
        stream,
        (evts) =>
          evts.some(
            (e) =>
              (e.data as { item?: { id?: string } })?.item?.id ===
              sentinel.data.item.id,
          ),
        `item.created for the sentinel note ${sentinel.data.item.id} on a type-filtered stream`,
      );

      const sawEdge = settled.some(
        (e) => (e.data as { edge?: { id?: string } })?.edge?.id === edgeId,
      );
      if (sawEdge) {
        return {
          present: true,
          evidence: `a stream filtered to type=core.note delivered edge.created for ${edgeId}`,
        };
      }
      // Absent, or delivered out of order: a server that sends the edge's
      // frame after the sentinel written behind it reads the same way
      // here, and `sync/resume.test.ts` is what tells the two apart.
      return {
        present: false,
        evidence: `a stream filtered to type=core.note delivered the notes' item events but not edge.created for ${edgeId} ahead of the sentinel written after it, so either edges are withheld under a filter and a filtered client's graph goes stale, or edge frames are delivered out of id order, which sync/resume.test.ts holds separately`,
      };
    },
  );
}

/**
 * Does a fresh connection announce the cursor it is starting from?
 *
 * The question is whether a typed frame arrives that is not a mutation.
 * Mutation events are excluded by name rather than by hoping the target is
 * quiet: other files in the run write to the same server, and one of their
 * writes on an unfiltered stream would otherwise read as an announcement.
 *
 * **`absent` here fails every test that requires the rule, so it may not rest
 * on a quiet window.** The `: connected` comment is written synchronously as
 * the response opens, so waiting for it separates a closed socket from an open
 * one and nothing else — it cannot tell "no announcement" from "not yet", and
 * a late frame would fail every one of those tests with an evidence line that
 * reads as a finding about the server.
 *
 * So the probe writes a marker and waits for the marker's own event. An
 * announcement names the point the stream starts from, so it can only precede
 * the first event that stream delivers; once the marker's frame has arrived,
 * an announcement that was going to come has come, and its absence is an
 * observation. The marker doubles as a control: a stream that never delivers
 * it fails the probe rather than answering it.
 */
async function probeAnnouncedCursor(args: {
  client: MarfaClient;
  ctx: TestContext;
  apiUrl: string;
  apiKey: string;
}): Promise<RuleFinding> {
  const { client, ctx, apiUrl, apiKey } = args;
  return withStream(apiUrl, apiKey, {}, async (stream) => {
    if (stream.response.status !== 200) {
      throw new IndeterminateProbe(
        "announcedCursor",
        `the subscription answered ${stream.response.status} rather than opening`,
      );
    }
    // Let the subscription settle, or the marker is published to nobody and
    // the wait below burns the hook budget instead of answering.
    await new Promise((r) => setTimeout(r, 250));
    const marker = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "probe-announced-cursor" },
    });
    if (!marker.ok) {
      throw new IndeterminateProbe(
        "announcedCursor",
        `could not write the marker this probe waits for (${marker.status})`,
      );
    }
    const markerId = marker.data.item.id;
    trackItem(ctx, markerId);

    const { events } = await collectUntil(
      stream,
      (evts) =>
        evts.some(
          (e) => (e.data as { item?: { id?: string } })?.item?.id === markerId,
        ),
      `the marker ${markerId} to reach the stream, after which an announcement either arrived or was never sent`,
    );
    const announcement = events.find(
      (e) =>
        !MUTATION_EVENT_NAMES.has(e.event) && e.event !== "catchup_too_old",
    );
    if (announcement) {
      return {
        present: true,
        evidence: `a fresh connection sent "${announcement.event}" ahead of the first mutation it delivered: ${JSON.stringify(announcement.data).slice(0, 160)}`,
      };
    }
    return {
      present: false,
      evidence: `a fresh connection delivered a write made after it opened with no typed frame ahead of it, so a client cannot learn the cursor its subsequent read is relative to`,
    };
  });
}

/**
 * Track every item written under this file's credential.
 *
 * A write whose side effect is another row leaves the caller with no id to
 * record, and the `source` a credential stamps is the only handle on it. A
 * refused listing is a failure, not an empty answer: an empty list is the one
 * answer indistinguishable from a question never asked. The cursor is
 * followed to the end for the same reason.
 */
export async function trackSourceScopedItems(args: {
  client: MarfaClient;
  ctx: TestContext;
}): Promise<void> {
  const { client, ctx } = args;
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ source: ctx.source, limit: "200" });
    if (cursor !== undefined) query.set("cursor", cursor);
    const listing = await client.rawRequest<{
      data?: Array<{ id: string }>;
      next_cursor?: string | null;
    }>(`/items?${query.toString()}`);
    if (!listing.ok) {
      throw new Error(
        `listing the rows written under ${ctx.source} answered ${String(listing.status)}: ${JSON.stringify(listing.error)}`,
      );
    }
    for (const item of listing.data.data ?? []) trackItem(ctx, item.id);
    if (!listing.data.next_cursor) return;
    cursor = listing.data.next_cursor;
  }
  throw new Error(`listing the rows written under ${ctx.source} did not end`);
}

/**
 * Render the findings as a block the run log can carry.
 *
 * Printed once per run so a reader can see every answer and the observation
 * behind it, rather than only the verdict a failing test reports.
 */
export function formatCapabilities(caps: SyncCapabilities): string {
  const lines = RULE_KEYS.map((key) => {
    const { present, evidence } = caps[key];
    return `  ${present ? "present" : "absent "}  ${key.padEnd(22)}  ${evidence}`;
  });
  return `sync contract capabilities:\n${lines.join("\n")}`;
}

/**
 * Fail this test unless the rule is present, saying what the probe observed.
 * The referee has one target, so an absent rule is a regression rather than
 * an optional capability, and a probe that could not decide threw before
 * reaching here.
 */
export function requireRule(caps: SyncCapabilities, key: RuleKey): void {
  const finding = caps[key];
  if (finding.present) return;
  throw new Error(
    `the server does not implement "${key}": ${finding.evidence}`,
  );
}

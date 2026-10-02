import type { Context, ErrorHandler, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { ErrorCode, MarfaError, generateId } from "@withmarfa/shared";
import type { AppEnv } from "./auth.js";
import { log } from "./logger.js";
import type { Storage } from "../storage/interface.js";
import { withPreparedHeaders } from "../prepared-headers.js";
import { CONTRACT_VERSION } from "../contract.js";

/**
 * A write that is retried after a lost response learns what its first
 * attempt did.
 *
 * A client whose response never arrived cannot ask the door again and get
 * an answer to the question it has. A repeated create collides with
 * itself, a repeated update conflicts against its own change, and a
 * repeated delete is not found; each is a correct answer about the second
 * ask and none is an answer about the first. So the first attempt's
 * status and body are recorded against the caller's `Idempotency-Key` and
 * a repeat is served from the record.
 *
 * **A 409 is recorded like any other outcome, and that is the case this
 * exists for most.** A conflict is a real thing that happened, and a
 * client told it a second time cannot distinguish "somebody else holds
 * this" from "my own earlier write holds this". Replaying the stored one
 * says which.
 *
 * **Independent of the id-based create acknowledgment.** `POST /items`
 * and `POST /edges` already answer a repeat that carries a caller-minted
 * id, for a shipped client that retries with its id and no key. Neither
 * mechanism is built on the other and neither consults the other: the
 * acknowledgment is retired once that client adopts keys, and a
 * dependency either way would make retiring it break this.
 */

/**
 * The doors a key is honored on, spelled exactly as Hono registers them.
 *
 * **Enumerated at the layer writes happen, not by walking routes.** The
 * property is about a write, and several callers reach `items.create`,
 * `items.update`, `items.delete`, `edges.createRaw`,
 * `edges.updateProperties` and `edges.delete` with no HTTP request at all
 * — the enrichment sweeper, the bulk-action worker, and the grant
 * inactivity retirer, which reaches `items.update` through
 * `revokeProjectedGrant`. A route walk sees none of them, and cannot show
 * that they are excluded deliberately rather than missed: all three write on
 * their own schedule, with no caller to hand them a key.
 *
 * That list is a snapshot and the query is the thing to keep: grep the six
 * methods across `packages/server/src` outside `storage/`, and trace each
 * hit back to whether a request drives it. The retirer is the easy one to
 * miss: it runs as a housekeeping job and its write is two calls away.
 * `routes/idempotent-write-doors.test.ts` holds the doors that do carry a
 * key against the app's own route table.
 *
 * **A door over a free-text PATH segment is safe here; the query is not
 * covered.** `canonicalPath` re-spells each path segment before the digest,
 * so two encodings of one request are one fingerprint and a retry that
 * re-encodes is replayed rather than refused. That is what lets a tag, an
 * extension namespace or any other free-text path segment join this list.
 *
 * **The query string is hashed as written**, so a door taking a free-text
 * query value would refuse a retry that re-encoded it. No door here takes
 * one: `PATCH /items/:id` carries `conflict`, a closed enum,
 * `DELETE /items/:id/purge` carries `version`, a whole number, and the rest
 * carry no query parameter.
 */
export const IDEMPOTENT_WRITE_DOORS: readonly string[] = [
  "POST /items",
  "PATCH /items/:id",
  "DELETE /items/:id",
  "DELETE /items/:id/purge",
  "POST /items/:id/transition",
  "POST /items/:id/restore",
  "POST /edges",
  "PATCH /edges/:id",
  "DELETE /edges/:id",
  "POST /folders",
  "PATCH /folders/:id",
  "POST /folders/:id/revoke",
  "POST /items/bulk-actions",
];

/**
 * How long a claim may be held before another arrival may take it over.
 *
 * A process that dies between claiming and completing leaves the key held
 * with nothing coming to complete it, and the caller retrying is exactly
 * the client this mechanism serves — so without a lease the one failure
 * it is built for produces a permanent refusal until the retention sweep.
 * Sized well above the slowest write on these doors (a create with inline
 * edges) and well below any interval a client would wait between retries.
 */
const CLAIM_LEASE_MS = 60_000;

/**
 * How many times an arrival may re-ask for a key it lost to something that
 * turned out not to be there.
 *
 * Three rather than two: a single request can legitimately meet both
 * losses the loop handles — a vanished holder, then an expired claim taken
 * over by somebody else — and two passes would give up on a pair that one
 * more pass settles. Past that the answer is a retryable refusal, because
 * an unbounded retry that is correct in theory is worse than a bounded one
 * that gives up loudly.
 */
const CLAIM_ATTEMPTS = 3;

/**
 * The largest response body kept, in bytes of UTF-8.
 *
 * The global request-body cap on this surface is 1 MB, and a single item
 * or edge response is that plus a bounded hydration envelope, so this is a
 * ceiling nothing reaches rather than a budget anything is trimmed to.
 * Past it the outcome is still recorded — the repeat still performs no
 * second write and still learns the status — and only the body is
 * dropped, because the alternative is either storing an unbounded blob per
 * key or letting the repeat write again. Of the two things that can go
 * wrong past this line, a body the caller cannot be handed is strictly
 * better than a duplicate write, which is the whole point of the feature.
 */
const MAX_STORED_BODY_BYTES = 1_048_576;

/** Bounds on the key itself, so a header cannot become a storage vector. */
const MAX_KEY_LENGTH = 255;

/**
 * Outcomes that give the key back instead of pinning it.
 *
 * An authorization result describes the credential, not the request, and
 * the credential is the one thing a caller is expected to fix and retry
 * with. 409 is deliberately absent: a conflict IS a property of the
 * request, and replaying it is the case this feature exists for most.
 */
const RELEASED_STATUSES = new Set([401, 403]);

/**
 * **This rule keys on the status, not on whether the request wrote**, and
 * that is safe only because no door here can write and then answer 401 or
 * 403 outside a transaction.
 *
 * What holds it up today: every door refuses an absent credential before
 * writing anything, the middleware-level 403 sources are registered ahead
 * of this mount, and the one write-then-403 window — the source-id upsert
 * branch throwing from the inline-edge callback — sits inside a
 * transaction that rolls back. So a released key never names a write that
 * happened.
 *
 * **Adding a 403 that can be raised after an uncommitted write turns a
 * released key into a duplicate write**, because the retry finds no record
 * and writes again. If that shape ever becomes reachable, this set is the
 * thing to revisit: release on "the request wrote nothing" rather than on
 * the status.
 */

const HEADER = "Idempotency-Key";
const REPLAY_HEADER = "Idempotency-Replayed";

/**
 * The credential a key belongs to: a key's id, or for a signed-in app its
 * grant, `oauth:<client>:<user>`, the pair a webhook subscription's owner
 * names.
 *
 * **Every key lives inside one credential's keyspace.** Two credentials
 * choosing keys independently will choose the same one sooner or later;
 * shared, the second would be refused for a key it never used, or handed
 * the first's stored answer, a body derived from rows it may not read.
 *
 * **The grant rather than the access token**, because a refresh replaces
 * the token row, and a refresh between a lost response and its retry is the
 * case this feature exists for: keyed on the token, the retry would find no
 * record and write again. A key's id does not rotate under it.
 */
function credentialHandle(c: Context<AppEnv>): string {
  const apiKey = c.get("apiKey");
  if (apiKey === undefined) return "";
  return c.get("authType") === "oauth" ? apiKey.source : apiKey.id;
}

/**
 * This request's key as its credential's own, for a write that derives a
 * value from the key, or null when the request carries no key or no
 * credential. Derived from the bare header, a value would be shared by
 * every credential choosing the same key.
 */
export function credentialIdempotencyKey(c: Context<AppEnv>): string | null {
  const key = c.req.header(HEADER);
  if (key === undefined || c.get("apiKey") === undefined) return null;
  return credentialScopedKey(credentialHandle(c), key);
}

/** A key within the credential `credentialHandle` names. */
export function credentialScopedKey(credential: string, key: string): string {
  return `${credential}\u0000${key}`;
}

/**
 * The path in one spelling, so two encodings of the same request digest
 * the same.
 *
 * Percent-encoding is not canonical: `/items/abc` and `/items/%61bc` name
 * one resource, and a fingerprint that does not match the stored one is
 * read as the same key being reused for a *different* request. Without one
 * spelling a retry that re-encoded a single character would be refused
 * `idempotency_key_reused` rather than replayed — and a key cannot be
 * un-spent by trying again, so the write could never complete under it.
 *
 * Segment by segment, and re-encoded rather than left decoded. Decoding
 * the pathname whole would turn `%2F` into a separator and collapse
 * `/items/a%2Fb` onto `/items/a/b`, which are two different resources;
 * that is the same class of bug in the opposite direction, and the one
 * that matters more, because it would serve one route's response for
 * another's request.
 *
 * A segment that does not decode has no canonical form but itself, so it
 * is kept verbatim. `decodeURIComponent` throws on a malformed escape,
 * and this runs on every keyed request.
 */
function canonicalPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      try {
        return encodeURIComponent(decodeURIComponent(segment));
      } catch {
        return segment;
      }
    })
    .join("/");
}

/**
 * What makes a repeat a repeat.
 *
 * The key alone is not enough: a client reusing a key for a different
 * request would be served an answer to a request it did not make, which
 * silently discards a write it believes it made — the failure this exists
 * to prevent, arriving from the other side. So the digest covers
 * everything that decides what the write does. The credential is not in
 * it, because the record is already that credential's own.
 */
async function fingerprint(
  c: Context<AppEnv>,
  body: string,
  contract: number,
): Promise<string> {
  const url = new URL(c.req.url);
  const material = [
    // A stored answer is shaped for the contract it was written under, and
    // a replay goes out under whatever contract the server now speaks. So a
    // retry that crosses a move of the number digests differently and is
    // refused as a reused key, rather than replayed under a header that
    // vouches for a shape the body does not have.
    String(contract),
    c.req.method,
    canonicalPath(url.pathname),
    // The query is left as written, and the reason is checkable rather
    // than a judgment: no door in IDEMPOTENT_WRITE_DOORS carries a query
    // value whose spelling can vary. Only PATCH /items/{id} takes one,
    // `conflict`, a closed enum of ASCII words. A door that later accepts
    // a free-text query value reopens exactly this bug on that axis, and
    // canonicalizing the query then also means deciding whether parameter
    // order is part of the request, which is a wider question than the
    // path's.
    url.search,
    body,
  ].join("\n");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The response a repeat is answered with, built from the stored row. */
function replay(status: number, contentType: string | null, body: string) {
  const headers = new Headers();
  headers.set("Content-Type", contentType ?? "application/json");
  headers.set(REPLAY_HEADER, "true");
  // The error handler stamps this on every error it renders, and a client
  // reading it must not find it missing purely because the response came
  // from the record.
  const code = errorCodeOf(body);
  if (code) headers.set("X-Error-Code", code);
  return new Response(body, { status, headers });
}

function errorCodeOf(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const error = (parsed as { error?: { code?: unknown } }).error;
    return typeof error?.code === "string" ? error.code : null;
  } catch {
    return null;
  }
}

/**
 * A replay is a fresh `Response`, so it starts with none of the headers the
 * middleware chain prepared for this request — the same discard the error
 * handler compensates for by copying `c.res.headers` before it renders.
 * `replay` re-added `X-Error-Code` by hand for that reason and stopped
 * there, leaving a replayed response with no `X-Request-ID` and, where the
 * deployment rate limits, no `X-RateLimit-*` trio.
 *
 * Both are worth more on a replay than anywhere else. A retry is the
 * request a client is most likely to be debugging and it had no id to
 * quote, and the replayed request consumes its rate-limit window like any
 * other, so a client polling a retry loop was losing sight of the budget it
 * was spending.
 *
 * `withPreparedHeaders` is shared with the handlers that build a `Response`
 * by hand for the same reason — see that function for what Hono does with
 * the prepared bag afterwards, which is not what the merge alone suggests.
 */

/**
 * `Idempotency-Key` on the doors in `IDEMPOTENT_WRITE_DOORS`.
 *
 * **Mounted outside any write transaction**, which is not a
 * preference: the claim must commit whether or not the write's own
 * transaction does, or a rolled-back write would take the record of it
 * with it and the second attempt would write for real.
 *
 * **Takes the app's own error handler** rather than re-deriving what a
 * thrown `MarfaError` renders as. A stored body that is nearly the one
 * that went out is worse than no store at all, and duplicating the
 * rendering is how the two drift.
 */
export function idempotencyMiddleware(opts: {
  storage: Storage;
  errorHandler: ErrorHandler<AppEnv>;
  /** The contract the answers are shaped for; a test names another. */
  contract?: number;
}): MiddlewareHandler<AppEnv> {
  const { storage, errorHandler, contract = CONTRACT_VERSION } = opts;

  return createMiddleware<AppEnv>(async (c, next) => {
    const key = c.req.header(HEADER);
    // Opt-in. A caller that sends no key gets exactly the behavior it got
    // before this existed, including two identical creates being two
    // items.
    if (key === undefined) return next();
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `${HEADER} must be between 1 and ${String(MAX_KEY_LENGTH)} characters`,
      );
    }

    // **No credential, no claim.** `authMiddleware` never rejects: every
    // failure path — absent bearer, an OAuth token that does not resolve —
    // sets `apiKey` to undefined and calls
    // `next()`, and the refusal is raised by the credential gate the route
    // carries, which is downstream of here. Claiming first would let an
    // unauthenticated stranger insert a row per request, keyed on 255
    // bytes of their choosing and kept for the whole retention window, on
    // a table with no quota; and a planted key would make a legitimate
    // caller's later use of the same one a fingerprint mismatch until it
    // aged out.
    //
    // An unauthenticated request has no write to make idempotent, so there
    // is nothing to give up by leaving it alone. No door here is the
    // bootstrap door, and if one ever were, a bootstrap request also
    // carries no `apiKey` and would take this same path — which is the
    // safe direction.
    const apiKey = c.get("apiKey");
    if (apiKey === undefined) return next();

    // Cloned so the route's own body read is untouched: the original
    // stream stays unconsumed and the validator parses it as usual.
    const bodyText =
      c.req.raw.body === null ? "" : await c.req.raw.clone().text();
    const digest = await fingerprint(c, bodyText, contract);

    const held = await acquire(storage, credentialHandle(c), key, digest);
    if ("answer" in held) return withPreparedHeaders(c, held.answer);

    const { recordId, heldSince } = held;
    let response: Response;
    try {
      await next();
      response = c.res;
    } catch (err) {
      // Rendered through the app's own handler, so the body recorded is
      // the body that goes out, byte for byte. Returned rather than
      // rethrown: it has already been rendered, and rethrowing would
      // render it a second time.
      // Hono's own dispatcher casts the same way before calling this:
      // `onError` is typed for an Error, and a throw of anything else
      // reaches it unchanged rather than being reshaped.
      const rendered = errorHandler(err as Error, c);
      response = rendered instanceof Promise ? await rendered : rendered;
    }

    await recordOutcome(storage, recordId, heldSince, response);
    return response;
  });
}

/**
 * Take the key, or produce the answer a caller who cannot have it gets.
 *
 * **The loop is for the two ways an arrival can lose a race to something
 * that is no longer there**, which are the same species and share one
 * budget: a claim whose holder was released or swept between the INSERT
 * and the read, and an expired claim taken over by somebody else in the
 * same instant. Both mean "ask again"; neither means anything about the
 * request.
 *
 * **Retrying here rather than inside the store** is the same split the
 * store's own contract states: it takes a key or reports who holds it, and
 * what an arrival means is decided in one place, above the store. A retry
 * budget is exactly such a decision, and a copy of it inside the store is
 * a second copy to keep in step.
 *
 * **Bounded, and it gives up rather than proceeding.** Each pass does at
 * most one INSERT, one SELECT and one UPDATE, so the work is bounded by
 * construction and cannot spin however the racers interleave; three passes
 * leave room for one of each loss in a single request. On exhaustion this
 * throws a retryable `409` and the write does not run. The alternative —
 * carrying on without a claim — is precisely the defect this loop was
 * added to close, so a spurious refusal in a race nobody has observed is
 * the better side to fail on.
 */
async function acquire(
  storage: Storage,
  credential: string,
  key: string,
  digest: string,
): Promise<{ recordId: string; heldSince: string } | { answer: Response }> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const id = generateId();
    const now = new Date().toISOString();
    const claim = await storage.idempotency.claim({
      id,
      credential,
      idempotency_key: key,
      fingerprint: digest,
      created_at: now,
    });
    // `now` is the row's `created_at`, and from here on it is this
    // caller's proof that the row is still the one it took. Every later
    // write to that row is fenced on it.
    if (claim.claimed) return { recordId: id, heldSince: now };

    const { held } = claim;
    // Lost the INSERT to a holder that was gone by the time it was read.
    // Nothing holds the key now and this caller owns no row, so the only
    // safe move is to ask again — and asking again is what the store
    // cannot do for itself without a second copy of this budget.
    if (held === null) continue;

    if (held.fingerprint !== digest) {
      throw new MarfaError(
        ErrorCode.IDEMPOTENCY_KEY_REUSED,
        `${HEADER} "${key}" was already used for a different request, or under another contract version`,
      );
    }

    if (held.state === "complete") {
      if (held.response_body === null || held.response_status === null) {
        throw new MarfaError(
          ErrorCode.IDEMPOTENCY_RESULT_NOT_RETAINED,
          `The response to ${HEADER} "${key}" was too large to retain, so it cannot be replayed. The original request was not repeated.`,
          { original_status: held.response_status },
        );
      }
      return {
        answer: replay(
          held.response_status,
          held.response_content_type,
          held.response_body,
        ),
      };
    }

    const expired = Date.parse(held.created_at) < Date.now() - CLAIM_LEASE_MS;
    if (!expired) {
      throw new MarfaError(
        ErrorCode.IDEMPOTENCY_KEY_IN_FLIGHT,
        `A request carrying ${HEADER} "${key}" is still being processed`,
      );
    }
    const won = await storage.idempotency.takeOverExpiredClaim({
      id: held.id,
      fingerprint: digest,
      heldSince: held.created_at,
      now,
    });
    // The takeover swaps in place, so the row keeps its id and its
    // `created_at` becomes `now`. The id alone therefore does NOT identify
    // a holder — the writer that was displaced still has it — which is
    // exactly why the fence travels with it.
    if (won) return { recordId: held.id, heldSince: now };
    // Somebody else took it over in the same instant. Their claim is
    // fresh, so the next pass reports it in flight rather than looping.
  }
  // Deliberately not the in-flight wording used inside the loop: reaching
  // here can mean the key was repeatedly taken and given up rather than
  // held, and saying something is being processed when nothing is would
  // send a reader looking for a request that does not exist. The code is
  // the same because the client's move is the same — retry.
  throw new MarfaError(
    ErrorCode.IDEMPOTENCY_KEY_IN_FLIGHT,
    `${HEADER} "${key}" could not be claimed after ${String(CLAIM_ATTEMPTS)} attempts because another request kept taking or releasing it. Nothing was written. Retry.`,
  );
}

/**
 * Record what went back, or give the key up.
 *
 * **Every write here is fenced on `heldSince`**, the `created_at` this
 * caller's claim carries. The id alone does not identify a holder: a
 * takeover swaps the row in place and keeps its id, so a writer that ran
 * past its lease and was displaced still holds the same id and would
 * otherwise delete or overwrite the row belonging to the writer that
 * replaced it. Both of those are how a duplicate write gets made, which is
 * what this whole mechanism exists to stop.
 *
 * **Three outcomes are given up rather than recorded**, and each for the
 * same reason: it is not a property of the request.
 *
 *   - A 5xx is a server fault. Pinning one would turn a transient failure
 *     into a permanent refusal for the retention window.
 *   - A 401 or 403 is a property of the credential. A caller whose token
 *     was expired or under-scoped fixes it and retries, and replaying the
 *     refusal at a corrected credential would be a wrong answer to the
 *     question actually being asked. A conflict is the opposite — it says
 *     something about the request, which is why 409 IS recorded.
 *
 * A 404 is recorded, a hidden row's included: releasing that one alone
 * would tell a row the key cannot read from a missing one.
 */
async function recordOutcome(
  storage: Storage,
  recordId: string,
  heldSince: string,
  response: Response,
): Promise<void> {
  try {
    if (response.status >= 500 || RELEASED_STATUSES.has(response.status)) {
      const released = await storage.idempotency.release(recordId, heldSince);
      if (!released) {
        log("warn", "Idempotency claim was already gone at release", {
          record_id: recordId,
          status: response.status,
        });
      }
      return;
    }
    const contentType = response.headers.get("Content-Type");
    // Read from a clone so the response the caller receives is untouched.
    const body = await response.clone().text();
    const retained =
      new TextEncoder().encode(body).byteLength <= MAX_STORED_BODY_BYTES;
    const recorded = await storage.idempotency.complete({
      id: recordId,
      heldSince,
      response_status: response.status,
      response_content_type: retained ? contentType : null,
      response_body: retained ? body : null,
      completed_at: new Date().toISOString(),
    });
    if (!recorded) {
      // The row is gone, or it is no longer the one this caller took —
      // its lease ran out and somebody else is writing under the same id.
      // Either way this outcome is not the one that row should carry, and
      // the fence is what stops it being written over the newer writer's.
      // Nothing to do about it now: the write has happened and the caller
      // is owed its response. Logged because the alternative is the
      // silence that hid a lost outcome once already, and because a repeat
      // of this key will now find no record and write for real.
      log("warn", "Idempotency outcome recorded against no row", {
        record_id: recordId,
        status: response.status,
      });
    }
  } catch (err) {
    // The write already happened and the caller is owed its response, so
    // this cannot become a failure. What it costs is that the claim stays
    // in flight until its lease runs out, which is the same shape as a
    // crashed writer and recovers the same way.
    log("warn", "Failed to record idempotency outcome", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

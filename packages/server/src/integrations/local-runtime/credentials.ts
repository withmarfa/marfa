/**
 * `mintCredential` for the integration runtime: no HTTP round-trip,
 * the supervisor calls `storage.keys.createRuntimeCredential` directly
 * for each dispatch it routes.
 *
 * Permissions are translated from the Integration manifest via the
 * shared builders (`manifest-permissions.ts`), so a credential can only
 * touch the types its manifest declares plus
 * the edge and extension namespaces it asked for. Two substrate-contract
 * grants ride along because no integration can run without them:
 * `connection.runtime` write (its own state subtree) and
 * `system.activity` write (status reporting). Reading its own Connection
 * needs no grant — `isOwnConnectionRead` in `middleware/auth.ts` admits
 * exactly that one row. A connection whose manifest cannot be resolved
 * mints fail-closed with those two grants and no type or edge reach.
 *
 * The credential is per-dispatch and carries an `expires_at` enforced at
 * the bearer gate. Its TTL is deliberately longer than the dispatch bound
 * (see `DEFAULT_RUNTIME_CREDENTIAL_TTL_MS`): the local substrate cannot
 * refresh mid-run, so a credential must outlive any dispatch that holds
 * it. Each mint retires the connection's other credentials outright, live
 * ones included, so per-dispatch minting cannot accumulate live keys.
 *
 * What makes that safe is that the only caller holds
 * `connection-dispatch:<id>` and mints inside it, so nothing else on the
 * connection can be holding one. A caller that does not hold that lock must
 * not reach this function: it would retire the credential a running dispatch
 * is using, and the bearer gate refuses a revoked credential exactly as it
 * refuses an expired one, so the dispatch would take 401s partway through
 * with nothing logged where the revocation happened.
 */
import { randomBytes } from "node:crypto";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { RuntimeCredential } from "@withmarfa/runtime-sdk";
import { hashApiKey } from "../../middleware/auth.js";
import {
  runtimeCredentialItemSource,
  withConnectionLifecycleLockInTransaction,
} from "../../connections/lifecycle-lock.js";
import type { Storage } from "../../storage/interface.js";
import {
  buildEdgePermissions,
  buildExtensionPermissions,
  buildTypePermissions,
} from "../../connections/manifest-permissions.js";
import {
  assertMintableSpaceScope,
  resolveRuntimeCredentialManifest,
  revokeSupersededRuntimeCredentials,
} from "../../connections/runtime-credential-lifecycle.js";

const KEY_PREFIX = "marfa_k1_";

/**
 * Longest a dispatch can run before pg-boss reclaims its job.
 *
 * The supervisor pins its dispatch queue to this value rather than inheriting
 * pg-boss's default, so the number below is the real bound rather than a
 * library default that could move under us.
 *
 * It is per FETCHED BATCH in pg-boss's own terms: one timer is armed across
 * whatever a worker was handed, and on expiry every job id in that batch is
 * failed together. The supervisor fetches one job at a time, so batch and
 * dispatch are the same thing here — but that equivalence is a property of
 * `batchSize: 1` in `supervisor.ts` rather than of the queue, and raising the
 * batch would silently make this a shared allowance again.
 *
 * The credential TTL derived below exceeds this bound, so expiry is
 * structurally unable to bite a live dispatch.
 */
export const DISPATCH_JOB_EXPIRY_SECONDS = 900;

/**
 * How much of the dispatch bound is held back so a yielding handler can
 * finish tidily. Purely the reserve — the soft limit derived below is what
 * a handler actually sees.
 *
 * What has to fit inside it, in order: the handler's in-flight page (aborted
 * at the deadline, but a socket close is not instant), its final cursor
 * writes, the worker posting its response back, the supervisor committing the
 * cursor delta, and the supervisor enqueuing the next slice. All but the
 * first are milliseconds against a healthy database. The reserve is sized for
 * an unhealthy one, because overrunning the bound is the exact failure this
 * whole mechanism exists to remove, and the cost of reserving too much is
 * only that a long sync takes one more slice than it strictly needed.
 */
const DISPATCH_YIELD_RESERVE_SECONDS = 300;

/**
 * How long a handler is given before `ctx.budget.shouldYield` goes true.
 *
 * Derived rather than written down, so the two can never drift into the
 * wrong order. A soft limit at or past the bound would be no limit at all:
 * the queue would reclaim the job before anything asked the handler to stop,
 * which is the behaviour that exists today.
 *
 * Not tunable by environment, for the reason the credential TTL is not. It
 * is one side of a three-clock ordering — soft limit < dispatch bound <
 * credential TTL — and a deployment that could move one side could invert it
 * and would find out by stranding records rather than by failing to boot.
 * A test injects its own through `ConsumerEnvironment`; a deployment does not.
 */
export const DISPATCH_SOFT_LIMIT_MS =
  (DISPATCH_JOB_EXPIRY_SECONDS - DISPATCH_YIELD_RESERVE_SECONDS) * 1000;

/**
 * Margin between the dispatch bound and the credential lifetime. Covers
 * the gap between minting the credential and the job actually starting
 * (queue latency, lock acquisition, worker-thread spawn).
 */
const CREDENTIAL_TTL_MARGIN_SECONDS = 300;

/**
 * Default runtime-credential lifetime.
 *
 * This MUST exceed the longest possible dispatch. The local substrate has
 * no working credential refresh: `worker-entry.ts` builds its
 * `ConnectionClient` with `refreshCredential: () => Promise.resolve(credential)`
 * — the same object — because the handler runs in a `worker_thread` with no
 * storage access and therefore nothing to mint from. On a 401 the client
 * re-presents the identical key and fails again. A credential that expires
 * mid-dispatch is unrecoverable: the run dies partway, and for a long
 * backfill (initial history sync, manual re-run) that is silent data loss
 * rather than a retry.
 *
 * Bounding TTL by the job expiry makes expiry structurally unable to bite a
 * live dispatch, which is what buys the right to enforce it at all — the
 * runtime has no mid-dispatch refresh, so the TTL is the whole guarantee.
 */
export const DEFAULT_RUNTIME_CREDENTIAL_TTL_MS =
  (DISPATCH_JOB_EXPIRY_SECONDS + CREDENTIAL_TTL_MARGIN_SECONDS) * 1000;
const DEFAULT_TTL_MS = DEFAULT_RUNTIME_CREDENTIAL_TTL_MS;

interface ConnectionProperties {
  kind?: string;
  integration_ref?: string;
  status?: string;
}

/**
 * Mint a fresh runtime credential for a Connection. Returns the wire
 * `RuntimeCredential` shape the SDK consumes — `{ api_key, expires_at,
 * connection_id }`.
 *
 * Throws when:
 *   - the Connection doesn't exist
 *   - the Connection isn't of kind `integration`
 *   - the Connection's `state` isn't `"active"` — symmetric with
 *     the HTTP-side mint gate; a revoked Connection cannot mint and
 *     therefore cannot run handlers
 */
export async function mintLocalRuntimeCredential(
  storage: Storage,
  salt: string,
  connectionId: string,
  authMode: "hosted" | "keys",
  ttlMs = DEFAULT_TTL_MS,
): Promise<RuntimeCredential> {
  // Same per-Connection lock the uninstall pipeline takes, for the same
  // reason it matters on the hosted mint: the state check below decides
  // whether a credential may exist, and uninstall is the thing that can
  // change the answer. The dispatch lock the supervisor already holds is
  // a different key and does not serialize against uninstall. Taking the
  // lifecycle lock inside the dispatch lock is a fixed order with no
  // cycle — uninstall takes only the lifecycle lock.
  //
  // The transaction-riding shape, for the reason given where it is
  // defined: this runs on every dispatch, and a lock holding a pool
  // connection of its own would let ordinary dispatch traffic exhaust the
  // pool. Everything below is database work, so there is no I/O to strand
  // inside the transaction.
  return withConnectionLifecycleLockInTransaction(
    storage,
    connectionId,
    async () => {
      const connection = await storage.items.get(connectionId);
      if (connection?.type !== "system.connection") {
        throw new MarfaError(
          ErrorCode.CONNECTION_NOT_FOUND,
          `Connection ${connectionId} not found`,
        );
      }
      if (connection.state !== "active") {
        throw new MarfaError(
          ErrorCode.CONNECTION_NOT_ACTIVE,
          `Connection ${connectionId} is ${connection.state}; cannot mint runtime credential`,
        );
      }
      const props = connection.properties as ConnectionProperties;
      if (props.kind !== "integration") {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `Connection ${connectionId} is not of kind integration (got ${props.kind ?? "undefined"})`,
        );
      }

      // A space-less credential is the platform tier, not a narrow one. The
      // rule is the substrate's, not the transport's, so it applies to the
      // in-process mint exactly as it does to the HTTP one.
      //
      // The caller-vs-manifest binding the hosted mint applies has no
      // counterpart here: there is no caller to bind to. The hosted check
      // exists because an integration Worker is a separate principal that
      // states which integration it is; this mint is called by the
      // supervisor in the same process, from a dispatch it routed itself.
      assertMintableSpaceScope(connection, authMode);

      // Resolve the manifest so the credential carries exactly the reach the
      // Integration declared at registration. No manifest means no reach beyond
      // the credential's own `connection.runtime` subtree: minting wide on a
      // resolution failure would silently hand out the whole space.
      const manifest = await resolveRuntimeCredentialManifest(
        storage,
        connection,
      );

      const rawKey = KEY_PREFIX + randomBytes(32).toString("hex");
      const keyHash = hashApiKey(rawKey, salt);
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      // source is unique-checked per space; the random suffix prevents
      // collisions within the credential's short TTL window.
      const suffix = randomBytes(4).toString("hex");
      const spaceId = connection.space_id ?? undefined;

      const minted = await storage.keys.createRuntimeCredential(
        {
          label: `local-runtime ${connectionId}`,
          source: `local-runtime:${connectionId}:${suffix}`,
          type_permissions: buildTypePermissions(
            manifest,
            connection.properties,
          ),
          extension_permissions: buildExtensionPermissions(manifest),
          edge_permissions: buildEdgePermissions(manifest),
          connection_id: connectionId,
          expires_at: expiresAt,
          // Stable across mints and across reinstalls, unlike `source`,
          // which carries a random suffix per credential. Keys items to the
          // integration and the space so a re-synced upstream record always
          // finds the row it wrote before.
          item_source: runtimeCredentialItemSource(manifest),
        },
        keyHash,
        spaceId,
      );

      // Retire this connection's other runtime credentials, live ones
      // included. Expiry is not the cutoff and has not been for two
      // revisions: sparing an unexpired sibling left three mints holding
      // three usable credentials, which is the accumulation this exists to
      // stop. What makes revoking a live one safe is the dispatch lock the
      // only caller holds, not the age of what it retires.
      //
      // Best-effort. A supersede failure must not fail the dispatch that
      // triggered the mint; the retention reaper is the backstop.
      await revokeSupersededRuntimeCredentials(
        storage,
        connectionId,
        spaceId,
        minted.id,
      );

      return {
        api_key: rawKey,
        expires_at: expiresAt,
        connection_id: connectionId,
      };
    },
  );
}

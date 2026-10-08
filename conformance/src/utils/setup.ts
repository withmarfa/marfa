import { TEST_OWNER } from "./target.js";
import { randomUUID } from "node:crypto";
import { MarfaClient } from "../client/api.js";
import type { TestContext, TrackedResource } from "../client/types.js";

/**
 * The target is required and has no default. An unset value stops the run
 * rather than reaching for a server nobody chose.
 */
export function requireApiUrl(): string {
  const url = process.env.MARFA_API_URL;
  if (!url) {
    throw new Error(
      "MARFA_API_URL is required. Point it at a locally booted server, e.g. " +
        "http://127.0.0.1:8600. `pnpm marfa:up` boots the server in this " +
        "checkout and writes an env file with both variables.",
    );
  }
  return url;
}

/**
 * The key the suite provisions with: the one the bootstrap mint returns, which
 * mints the per-file keys that hold the dataset.
 */
export function requireApiKey(): string {
  const key = process.env.MARFA_API_KEY;
  if (!key) {
    throw new Error(
      "MARFA_API_KEY is required. It is the provisioning key " +
        "`pnpm marfa:up` writes to its env file.",
    );
  }
  return key;
}

/**
 * Mint a key, retrying a dropped connection or a gateway failure. Every file
 * mints a key before it can do anything, so one lost response here takes
 * down every test in the file and reports as a hook error. A rejected payload
 * is deterministic and is not retried.
 */
async function mintKeyWithRetry<
  T extends {
    ok: boolean;
    status: number;
    error?: { error?: { code?: string } };
  },
>(mint: () => Promise<T>): Promise<T> {
  const isWorthRetrying = (r: T): boolean =>
    r.error?.error?.code === "NETWORK_ERROR" ||
    r.status === 502 ||
    r.status === 503 ||
    r.status === 504;

  const backoffsMs = [2000, 4000, 6000, 10000];
  let response = await mint();
  for (const wait of backoffsMs) {
    if (response.ok || !isWorthRetrying(response)) break;
    await new Promise((r) => setTimeout(r, wait));
    response = await mint();
  }
  return response;
}

/**
 * A per-file token, unique across runs, safe to embed in an identifier the
 * server parses.
 *
 * The leading letter matters: suites put this in a dotted segment of its own,
 * and the type-identifier grammar requires every segment to begin with a
 * letter. A raw UUID slice begins with a digit most of the time.
 */
export function newRunId(): string {
  return `r${randomUUID().slice(0, 11)}`;
}

/**
 * Set up an isolated test context: a per-file key whose server-stamped
 * `source` is unique to this file, and a client bound to it. Every write the
 * client makes carries `ctx.source`, which is what isolates one file's rows
 * from every other file's inside the one dataset. The key is tracked so
 * `cleanup` revokes it.
 *
 * The per-file key names no permission maps, and the provisioning key's mint is
 * not held to the widening rule, so it takes the whole dataset.
 */
export async function createTestContext(
  suite: string,
  file: string,
): Promise<{
  ctx: TestContext;
  client: MarfaClient;
  apiUrl: string;
  apiKey: string;
}> {
  const env = getClientFromEnv();
  const runId = newRunId();
  const source = `conformance-${runId}-${suite}-${file}`;

  const ctx: TestContext = {
    runId,
    source,
    trackedItems: [],
    trackedKeys: [],
    trackedEdges: [],
    trackedEdgeTypes: [],
    trackedFolders: [],
    trackedWebhooks: [],
    trackedTypes: [],
    client: undefined as unknown as MarfaClient,
  };

  const keyResp = await mintKeyWithRetry(() =>
    env.client.createKey({
      label: `${source}-key`,
      source,
      default_tier: "library",
    }),
  );
  if (!keyResp.ok || !keyResp.data) {
    throw new Error(
      `Failed to create per-test key for ${source}: ${JSON.stringify(keyResp.error)}`,
    );
  }

  const client = new MarfaClient({
    baseUrl: env.apiUrl,
    apiKey: keyResp.data.key,
  });
  ctx.client = client;
  ctx.trackedKeys.push(keyResp.data.id);

  trackRegisteredTypes(ctx, client);

  return { ctx, client, apiUrl: env.apiUrl, apiKey: keyResp.data.key };
}

/**
 * Mint a second key with its own `source` and return a client bound to it, for
 * racing two writers against one item. The key is tracked for revocation.
 */
export async function createSecondClient(
  ctx: TestContext,
  label = "second",
): Promise<MarfaClient> {
  const env = getClientFromEnv();
  const source = `${ctx.source}-${label}`;
  const keyResp = await mintKeyWithRetry(() =>
    env.client.createKey({
      label: `${source}-key`,
      source,
      default_tier: "library",
    }),
  );
  if (!keyResp.ok || !keyResp.data) {
    throw new Error(
      `Failed to create second client for ${source}: ${JSON.stringify(keyResp.error)}`,
    );
  }
  trackKey(ctx, keyResp.data.id);
  return new MarfaClient({ baseUrl: env.apiUrl, apiKey: keyResp.data.key });
}

export function trackItem(ctx: TestContext, id: string): void {
  if (!ctx.trackedItems.includes(id)) {
    ctx.trackedItems.push(id);
  }
}

export function trackKey(ctx: TestContext, id: string): void {
  if (!ctx.trackedKeys.includes(id)) {
    ctx.trackedKeys.push(id);
  }
}

export function trackEdge(ctx: TestContext, id: string): void {
  if (!ctx.trackedEdges.includes(id)) {
    ctx.trackedEdges.push(id);
  }
}

export function trackFolder(ctx: TestContext, id: string): void {
  if (!ctx.trackedFolders.includes(id)) {
    ctx.trackedFolders.push(id);
  }
}

export function trackEdgeType(ctx: TestContext, id: string): void {
  if (!ctx.trackedEdgeTypes.includes(id)) {
    ctx.trackedEdgeTypes.push(id);
  }
}

/**
 * Track an outbound webhook subscription for cleanup, with the credential that
 * registered it. Call it the moment the id is in hand: a subscription left
 * behind keeps attempting delivery. `DELETE /webhooks/{id}` answers 404 to a
 * credential that cannot see the row, which teardown reads as already gone, so
 * the registering credential is the one that has to delete it.
 */
export function trackWebhook(
  ctx: TestContext,
  id: string,
  createdBy?: unknown,
): void {
  if (ctx.trackedWebhooks.some((w) => w.id === id)) return;
  ctx.trackedWebhooks.push({ id, createdBy });
}

/**
 * Record every successful type registration made through this client, and
 * every re-parent, so `cleanup` removes the types in an order the server
 * accepts. Wrapping the client rather than asking each call site to remember
 * is what makes the rule hold for the next file too.
 */
export function trackRegisteredTypes(
  ctx: TestContext,
  client: MarfaClient,
): void {
  const original = client.registerType.bind(client);
  client.registerType = async (
    ...args: Parameters<MarfaClient["registerType"]>
  ) => {
    const response = await original(...args);
    if (response.ok) {
      const id = args[0]?.id;
      const parent = args[0]?.parent;
      if (typeof id === "string") {
        trackType(
          ctx,
          id,
          client,
          typeof parent === "string" ? parent : undefined,
        );
      }
    }
    return response;
  };

  const originalReplace = client.replaceType.bind(client);
  client.replaceType = async (
    ...args: Parameters<MarfaClient["replaceType"]>
  ) => {
    const response = await originalReplace(...args);
    if (response.ok) {
      const id = args[0];
      const parent = (args[1] as { parent?: unknown } | undefined)?.parent;
      const tracked = ctx.trackedTypes.find((t) => t.id === id);
      // A `PUT` that omits `parent` is not saying the type has none.
      if (tracked && typeof parent === "string") tracked.parent = parent;
    }
    return response;
  };
}

/**
 * Track a registered item type for cleanup, with the credential that
 * registered it and the parent it declared. A registered type is permanent
 * and global, so a suite that leaves them behind slowly stops modeling the
 * thing it exists to model.
 */
export function trackType(
  ctx: TestContext,
  id: string,
  createdBy?: unknown,
  parent?: string,
): void {
  if (ctx.trackedTypes.some((t) => t.id === id)) return;
  ctx.trackedTypes.push({ id, createdBy, parent });
}

/**
 * Deletes within a phase are independent, so they go out in bounded batches;
 * the cap keeps a large teardown inside the hook timeout without flooding the
 * server. Phase order is the caller's.
 */
const CLEANUP_CONCURRENCY = 8;
interface CleanupOutcome {
  kind: string;
  failed: number;
  total: number;
  firstStatus?: number;
}

async function deleteAll(
  ids: readonly string[],
  del: (id: string) => Promise<{ ok: boolean; status: number } | unknown>,
  kind: string,
): Promise<CleanupOutcome> {
  let failed = 0;
  let firstStatus: number | undefined;
  for (let i = 0; i < ids.length; i += CLEANUP_CONCURRENCY) {
    const batch = ids.slice(i, i + CLEANUP_CONCURRENCY);
    await Promise.all(
      batch.map(async (id) => {
        try {
          const res = (await del(id)) as
            { ok?: boolean; status?: number } | undefined;
          // A 404 is the goal state of a deletion: tests legitimately remove
          // their own fixtures mid-run. Any other refusal is a leak.
          if (res && res.ok === false && res.status !== 404) {
            failed += 1;
            firstStatus ??= res.status;
          }
        } catch (err) {
          failed += 1;
          console.warn(
            `${kind} cleanup threw for ${id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }),
    );
  }
  if (failed > 0) {
    console.warn(
      `${kind} cleanup failed for ${String(failed)}/${String(ids.length)} id(s)` +
        (firstStatus === undefined
          ? ""
          : ` (first status ${String(firstStatus)})`) +
        ". Fixtures are still on the target.",
    );
  }
  return { kind, failed, total: ids.length, firstStatus };
}

/**
 * Delete a phase's resources through the credential that created each one,
 * falling back to `fallback` where none was recorded. Both routes this serves
 * answer 404 to a credential that cannot see the row, and 404 is what
 * `deleteAll` treats as already gone.
 */
async function deleteAllByOwner(
  tracked: readonly TrackedResource[],
  fallback: MarfaClient,
  del: (
    client: MarfaClient,
    id: string,
  ) => Promise<{ ok: boolean; status: number } | unknown>,
  kind: string,
): Promise<CleanupOutcome> {
  const owner = new Map<string, MarfaClient>(
    tracked.map((t) => [t.id, (t.createdBy ?? fallback) as MarfaClient]),
  );
  return deleteAll(
    [...owner.keys()],
    (id) => del(owner.get(id) ?? fallback, id),
    kind,
  );
}

/**
 * Split the tracked types into deletion levels, deepest first.
 *
 * `DELETE /types/{id}` answers 409 while another registered type declares
 * this one as its parent, and deletes within a phase are concurrent, so
 * ordering only holds if a child's batch is awaited before its parent's. Each
 * level is one such batch. Depth counts only ancestors this teardown is
 * itself deleting. The walk carries the ids it has seen, because a loop here
 * would cost the whole run its report.
 */
export function typeDeletionLevels(
  tracked: readonly TrackedResource[],
): TrackedResource[][] {
  const byId = new Map(tracked.map((t) => [t.id, t]));
  const depthOf = (start: TrackedResource): number => {
    const seen = new Set<string>([start.id]);
    let depth = 0;
    let parent = start.parent;
    while (parent !== undefined && byId.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      depth += 1;
      parent = byId.get(parent)?.parent;
    }
    return depth;
  };

  const levels = new Map<number, TrackedResource[]>();
  for (const t of tracked) {
    const depth = depthOf(t);
    const bucket = levels.get(depth);
    if (bucket) bucket.push(t);
    else levels.set(depth, [t]);
  }
  return [...levels.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, members]) => members);
}

function mergeOutcomes(
  kind: string,
  parts: readonly CleanupOutcome[],
): CleanupOutcome {
  let failed = 0;
  let total = 0;
  let firstStatus: number | undefined;
  for (const part of parts) {
    failed += part.failed;
    total += part.total;
    firstStatus ??= part.firstStatus;
  }
  return { kind, failed, total, firstStatus };
}

/**
 * Teardown has one owner: this function. Files must not keep their own
 * delete loops beside it. Deleting a fixture mid-test as part of the test's
 * own logic is fine; cleanup treats the already-gone fixture as done.
 *
 * Phase order is load-bearing. Edges go first so `parent-of` cascades do not
 * race the deletion of tracked children. Items are soft-deleted then purged,
 * because a soft delete alone leaves the row. Webhooks, edge types and types
 * go through the credential that made them, types deepest-subtype first.
 * Keys go last, through the provisioning client, because one of the tracked
 * keys is the file's own. Types are deleted non-forced: a type that still
 * owns rows at that point is a genuine leak and fails loudly.
 *
 * Every phase runs before anything throws, and then it throws: a suite that
 * cannot clean up after itself must not report green.
 */
export async function cleanup(ctx: TestContext): Promise<void> {
  if (!ctx) return;
  const scoped = ctx.client as MarfaClient;
  const provisioner = (ctx.provisioningClient ??
    getClientFromEnv().client) as MarfaClient;
  const outcomes: CleanupOutcome[] = [];
  outcomes.push(
    await deleteAll(ctx.trackedEdges, (id) => scoped.deleteEdge(id), "Edge"),
  );
  // The first reportable refusal wins: a refused soft delete leaves a live row
  // and the purge behind it answers 404, so reporting only the purge would
  // hide the failure that left something behind. A 404 on the delete is
  // already-gone and must not shadow the purge's answer.
  outcomes.push(
    await deleteAll(
      ctx.trackedItems,
      async (id) => {
        const removed = await scoped.deleteItem(id);
        const purged = await scoped.purgeItem(id);
        const removeReported = !removed.ok && removed.status !== 404;
        return removeReported ? removed : purged;
      },
      "Item",
    ),
  );
  outcomes.push(
    await deleteAll(
      ctx.trackedFolders,
      async (id) => {
        const revoked = await scoped.revokeFolder(id);
        const purged = await scoped.purgeItem(id);
        // 400 is `invalid_transition`: the fixture revoked it already.
        const revokeReported =
          !revoked.ok && revoked.status !== 404 && revoked.status !== 400;
        return revokeReported ? revoked : purged;
      },
      "Folder",
    ),
  );
  outcomes.push(
    await deleteAllByOwner(
      ctx.trackedWebhooks,
      scoped,
      (c, id) => c.deleteWebhook(id),
      "Webhook",
    ),
  );
  outcomes.push(
    await deleteAll(
      ctx.trackedEdgeTypes,
      (id) => scoped.deleteEdgeType(id),
      "Edge-type",
    ),
  );
  const typeLevels: CleanupOutcome[] = [];
  for (const level of typeDeletionLevels(ctx.trackedTypes)) {
    typeLevels.push(
      await deleteAllByOwner(
        level,
        scoped,
        (c, id) => c.deleteType(id),
        "Type",
      ),
    );
  }
  outcomes.push(mergeOutcomes("Type", typeLevels));
  // Before the keys go: a registration stands after its key is revoked
  // (`connectors/revoked-registration-stays`), and only the operator can remove another key's.
  outcomes.push(await removeTrackedRegistrations(ctx));
  outcomes.push(
    await deleteAll(ctx.trackedKeys, (id) => provisioner.revokeKey(id), "Key"),
  );

  const failures = outcomes.filter((o) => o.failed > 0);
  if (failures.length > 0) {
    throw new Error(
      "Cleanup left fixtures on the target: " +
        failures
          .map((f) => `${f.kind} ${String(f.failed)}/${String(f.total)}`)
          .join("; "),
    );
  }
}

/**
 * Remove every connector registration a tracked key made, through the
 * operator. Called by `cleanup`, and by a file whose fixtures register, so
 * one failed fixture does not hand the next a registration it did not make.
 * Without the operator key nothing can remove another key's registration,
 * and nothing is attempted.
 */
export async function removeTrackedRegistrations(
  ctx: TestContext,
): Promise<CleanupOutcome> {
  const kind = "Connector";
  if (ctx.trackedKeys.length === 0 || !process.env.MARFA_MANAGEMENT_KEY) {
    return { kind, failed: 0, total: 0 };
  }
  const operator = getManagementClient();
  const listed = await operator.listConnectors();
  if (!listed.ok) {
    console.warn(
      `${kind} cleanup could not list registrations (status ${String(listed.status)}).`,
    );
    return { kind, failed: 1, total: 1, firstStatus: listed.status };
  }
  const mine = listed.data.data
    .filter((row) => ctx.trackedKeys.includes(row.key_id))
    .map((row) => row.id);
  return deleteAll(mine, (id) => operator.deleteConnector(id), kind);
}

/**
 * The operator key's client, for the operator-only maintenance routes.
 * Required by the fixtures that call it; a missing variable is a failure,
 * not a skip.
 */
export function getManagementClient(): MarfaClient {
  const key = process.env.MARFA_MANAGEMENT_KEY;
  if (!key)
    throw new Error(
      "MARFA_MANAGEMENT_KEY is required; boot the fixture server first",
    );
  return new MarfaClient({ baseUrl: requireApiUrl(), apiKey: key });
}

export function getOwnerClient(): MarfaClient {
  const key = process.env.MARFA_OWNER_COOKIE;
  if (!key) {
    throw new Error(
      "MARFA_OWNER_COOKIE is required for direct owner fixtures. " +
        "`pnpm marfa:up` writes it to its env file.",
    );
  }
  return new MarfaClient({
    baseUrl: requireApiUrl(),
    ownerCookie: key,
    ownerCredentials: TEST_OWNER,
  });
}

/**
 * Get the provisioning client and configuration from the environment.
 */
export function getClientFromEnv(): {
  client: MarfaClient;
  apiUrl: string;
  apiKey: string;
  perfScale: "small" | "medium" | "large";
} {
  const apiUrl = requireApiUrl();
  const apiKey = requireApiKey();
  const perfScale = (process.env.MARFA_PERF_SCALE ?? "small") as
    "small" | "medium" | "large";

  const client = new MarfaClient({ baseUrl: apiUrl, apiKey });

  return { client, apiUrl, apiKey, perfScale };
}

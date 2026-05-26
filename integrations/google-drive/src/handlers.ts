/**
 * Google Drive (v3) inbound handlers.
 *
 * Drive v3 specifics shaping this handler:
 *
 *   - **Initial sync via `files.list`** — paginated under
 *     `q=trashed=false`. Seeds the mapping table on cold start.
 *   - **Incremental via `changes.list`** with a persisted
 *     `pageToken`. First-ever sync seeds the token from
 *     `changes.getStartPageToken`.
 *   - **`changes.watch` push notifications** — whole-account scope,
 *     one channel per Connection. Renewal cron runs inside the
 *     schedule trigger with zero-downtime ordering (new channel
 *     first, then stop old) — same shape Calendar uses.
 *   - **Tombstones** — a `change.removed: true` or `file.trashed:
 *     true` surfaces as a Marfa tombstone on the mapped item.
 *   - **No outbound writes in v1.** `direction: "inbound"` on the
 *     manifest; `handleItemEvent` is a defensive no-op that just
 *     filters self-events.
 *
 * **Blob handling — `metadata` and `all-files` modes.** The
 * `download_mode` configuration field picks between:
 *
 *   - `metadata` (default) — items land as `google.drive.file` with
 *     `blob_ref` absent. The Drive-side checksums (`md5`, `sha256`)
 *     and file id are still captured as independent properties.
 *   - `all-files` — downloadable files get their bytes ingested via
 *     `ctx.marfa.uploadBlob` (T-239). On success the item lands as
 *     `core.file` with `properties.blob_ref = sha256:<hex>`.
 *     Google-native types (`application/vnd.google-apps.*`),
 *     files over the configurable size ceiling, and per-file
 *     download failures all fall back to `google.drive.file` with
 *     `blob_ref` absent. The activity log carries the reason.
 *
 * The programmatic invariant consumers rely on:
 * `typeof item.properties.blob_ref === "string"` ⇔ bytes are
 * fetchable via `GET /blobs/{blob_ref}`. `glob:<pattern>` is
 * declared but not yet wired (separate ticket).
 */
import {
  registerScheduleHandler,
  registerItemEventHandler,
  registerWebhookHandler,
  type ConnectionContext,
  type ScheduleMessage,
  type ItemEventMessage,
  type WebhookHandlerInput,
  type HandlerResult,
  type CreateItemInput,
} from "@withmarfa/runtime-sdk";
import {
  DRIVE_API_BASE,
  DEFAULT_TARGET_TYPE,
  FILES_FIELDS,
  CHANGES_FIELDS,
  CHANNEL_RENEW_LEEWAY_MS,
  CHANNEL_TTL_MS,
} from "./manifest.js";

const CURSOR_KEY = "main";

/** Initial-sync page size. Drive v3 caps at 1000. */
const FILES_PAGE_SIZE = 100;

/** Initial-sync hard cap on pages to prevent runaway against a
 *  huge Drive on first connect. The harness against Oblix has a few
 *  test files; production deployments would want this configurable
 *  via `connection.properties.configuration.initial_sync_max_files`. */
const INITIAL_SYNC_PAGE_LIMIT = 50;

interface DriveCursor {
  /** Drive file id → Marfa item id. */
  mappings: Record<string, string>;
  /** changes.list pageToken — opaque. */
  pageToken: string | null;
  /** Whether initial files.list seed has completed. */
  seeded: boolean;
  /** ISO timestamp of the last successful sweep. */
  last_inbound_at: string | null;
  /** Whole-account watch channel, if push notifications are enabled. */
  channel?: ChannelState;
  /** Transient stash for the previous channel during renewal. Drained
   *  by stopping each entry. */
  retired_channels?: ChannelState[];
}

interface ChannelState {
  channel_id: string;
  resource_id: string;
  expiration_ms: number;
  channel_token: string;
}

interface ConnectionConfig {
  target_type: string;
  /** `metadata` (default) | `all-files` | `glob:<pattern>`.
   *  `metadata` and `all-files` are both wired (T-239); `glob:<pattern>`
   *  is declared but still falls through to `metadata` semantics
   *  pending a separate ticket. Typed as `string` because `glob:`
   *  is open-ended. */
  download_mode: string;
  /** Per-file size ceiling (bytes) for `all-files` mode. Files over
   *  this skip the byte ingest and land as `google.drive.file`
   *  without a `blob_ref`. Default 25 MB — see
   *  `DEFAULT_MAX_FILE_SIZE_BYTES` below for the Worker-memory
   *  reasoning. Server-side `MAX_BLOB_SIZE` (50 MB default) is the
   *  upper bound from the other side. */
  max_file_size_bytes: number;
  /** Set when an inbound webhook subscription has been minted at
   *  install time; enables push notifications. */
  inbound_webhook_url: string | null;
}

/**
 * Per-file size ceiling for `all-files` ingest. 25 MB is the
 * Worker-memory budget, not the server cap — the all-files path
 * transiently holds the file twice (the `arrayBuffer()` from the
 * proxy response, then again as the body passed to `uploadBlob`,
 * which fetch consumes asynchronously). Peak ≈ 2 × file_size +
 * handler state (~10 MB) + isolate baseline (~30 MB). A 25 MB cap
 * keeps the transient peak under ~90 MB inside the 128 MB Workers
 * isolate, with ~40 MB headroom for the rest of the run. Raising
 * past 25 MB risks Worker OOM until the paired stream-accepting
 * SDK overload + server-side streaming follow-up lands.
 */
export const DEFAULT_MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

async function resolveConnectionConfig(
  ctx: ConnectionContext,
): Promise<ConnectionConfig> {
  try {
    const connection = await ctx.marfa.getItem(ctx.connection_id);
    const props = connection?.properties as
      | { configuration?: Record<string, unknown> }
      | undefined;
    const cfg = props?.configuration ?? {};
    const targetType =
      typeof cfg.target_type === "string" && cfg.target_type.length > 0
        ? cfg.target_type
        : DEFAULT_TARGET_TYPE;
    const downloadMode =
      typeof cfg.download_mode === "string" && cfg.download_mode.length > 0
        ? cfg.download_mode
        : "metadata";
    const inboundUrl =
      typeof cfg.inbound_webhook_url === "string" &&
      cfg.inbound_webhook_url.length > 0
        ? cfg.inbound_webhook_url
        : null;
    const maxFileSizeRaw = cfg.max_file_size_bytes;
    const maxFileSize =
      typeof maxFileSizeRaw === "number" &&
      Number.isFinite(maxFileSizeRaw) &&
      maxFileSizeRaw > 0
        ? Math.floor(maxFileSizeRaw)
        : DEFAULT_MAX_FILE_SIZE_BYTES;
    return {
      target_type: targetType,
      download_mode: downloadMode,
      max_file_size_bytes: maxFileSize,
      inbound_webhook_url: inboundUrl,
    };
  } catch {
    return {
      target_type: DEFAULT_TARGET_TYPE,
      download_mode: "metadata",
      max_file_size_bytes: DEFAULT_MAX_FILE_SIZE_BYTES,
      inbound_webhook_url: null,
    };
  }
}

interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
  owners?: { emailAddress?: string; displayName?: string }[];
  parents?: string[];
  trashed?: boolean;
  webViewLink?: string;
  iconLink?: string;
  thumbnailLink?: string;
  md5Checksum?: string;
  sha256Checksum?: string;
  etag?: string;
}

interface FilesListResponse {
  files?: DriveFile[];
  nextPageToken?: string;
}

interface DriveChange {
  fileId?: string;
  removed?: boolean;
  time?: string;
  file?: DriveFile;
}

interface ChangesListResponse {
  changes?: DriveChange[];
  nextPageToken?: string;
  newStartPageToken?: string;
}

interface StartPageTokenResponse {
  startPageToken?: string;
}

export async function handleSchedule(
  ctx: ConnectionContext,
  message: ScheduleMessage,
): Promise<HandlerResult> {
  void message;
  const config = await resolveConnectionConfig(ctx);
  const cursor: DriveCursor = ((await ctx.cursor.read(
    CURSOR_KEY,
  )) as DriveCursor | null) ?? {
    mappings: {},
    pageToken: null,
    seeded: false,
    last_inbound_at: null,
  };

  // Channel renewal — only when an inbound webhook URL is configured.
  if (config.inbound_webhook_url !== null) {
    await ensureChannel(ctx, cursor, config.inbound_webhook_url);
  }

  let totalUpserted = 0;
  let totalSkippedEcho = 0;
  let totalTrashed = 0;
  const blobOutcomes: BlobOutcomeCounts = {
    files_with_blob: 0,
    skipped_google_native: 0,
    oversize: 0,
    download_failed: 0,
  };

  // Cold start: seed pageToken + initial files.list pass.
  if (!cursor.seeded || cursor.pageToken === null) {
    const tokenResp = await ctx.marfa.proxyRequest(
      "GET",
      `${DRIVE_API_BASE}/changes/startPageToken`,
    );
    if (!tokenResp.ok) {
      return reportFailure(
        ctx,
        `changes.getStartPageToken returned ${String(tokenResp.status)}`,
        null,
        tokenResp.status >= 500,
      );
    }
    const tokenBody: StartPageTokenResponse = await tokenResp.json();
    if (typeof tokenBody.startPageToken !== "string") {
      return reportFailure(
        ctx,
        "changes.getStartPageToken returned no startPageToken",
        null,
        true,
      );
    }
    cursor.pageToken = tokenBody.startPageToken;

    // Initial files.list seed.
    const initial = await initialFilesListSweep(ctx, cursor, config);
    totalUpserted += initial.upserted;
    totalSkippedEcho += initial.skipped;
    totalTrashed += initial.trashed;
    addBlobOutcomes(blobOutcomes, initial.blobs);
    cursor.seeded = true;
  }

  // Incremental: changes.list with the stored pageToken. After the
  // cold-start branch above, cursor.pageToken is always a string —
  // the explicit annotation makes the loop body type-clean.
  let pageToken: string = cursor.pageToken;
  for (;;) {
    const params = new URLSearchParams();
    params.set("pageToken", pageToken);
    params.set("includeRemoved", "true");
    params.set("pageSize", String(FILES_PAGE_SIZE));
    params.set("fields", CHANGES_FIELDS);
    const path = `${DRIVE_API_BASE}/changes?${params.toString()}`;

    let resp: Response;
    try {
      resp = await ctx.marfa.proxyRequest("GET", path);
    } catch (err) {
      return reportFailure(ctx, "changes.list fetch failed", err, true);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return reportFailure(
        ctx,
        `changes.list returned ${String(resp.status)}`,
        new Error(text.slice(0, 500)),
        resp.status >= 500,
      );
    }
    let payload: ChangesListResponse;
    try {
      payload = await resp.json();
    } catch (err) {
      return reportFailure(ctx, "changes.list parse failed", err, true);
    }

    for (const change of payload.changes ?? []) {
      const result = await applyChange(ctx, cursor, change, config);
      totalUpserted += result.upserted;
      totalSkippedEcho += result.skipped;
      totalTrashed += result.trashed;
      addBlobOutcomes(blobOutcomes, result.blobs);
    }

    if (typeof payload.nextPageToken === "string") {
      pageToken = payload.nextPageToken;
      continue;
    }
    if (typeof payload.newStartPageToken === "string") {
      cursor.pageToken = payload.newStartPageToken;
    }
    break;
  }

  cursor.last_inbound_at = new Date().toISOString();
  await ctx.cursor.write(CURSOR_KEY, cursor);

  const summary = formatRunSummary(
    totalUpserted,
    totalSkippedEcho,
    totalTrashed,
    config.download_mode,
    blobOutcomes,
  );
  await ctx.activity.emit({
    severity: "info",
    summary,
    detail: {
      upserted: totalUpserted,
      skipped_echo: totalSkippedEcho,
      trashed: totalTrashed,
      download_mode: config.download_mode,
      ...blobOutcomes,
    },
  });

  return { ok: true };
}

function formatRunSummary(
  upserted: number,
  skippedEcho: number,
  trashed: number,
  downloadMode: string,
  blobs: BlobOutcomeCounts,
): string {
  const base = `google-drive inbound: upserted=${String(upserted)} echo_skipped=${String(skippedEcho)} trashed=${String(trashed)}`;
  if (downloadMode !== "all-files") return base;
  const tail =
    ` (download_mode=all-files: files_with_blob=${String(blobs.files_with_blob)}` +
    ` skipped_google_native=${String(blobs.skipped_google_native)}` +
    ` oversize=${String(blobs.oversize)}` +
    ` download_failed=${String(blobs.download_failed)})`;
  return base + tail;
}

interface SweepCounts {
  upserted: number;
  skipped: number;
  trashed: number;
  blobs: BlobOutcomeCounts;
}

/**
 * Per-run breakdown of `all-files` blob-ingest outcomes (T-239).
 * - `files_with_blob` — bytes successfully uploaded; item lands as
 *   `core.file` with `properties.blob_ref = sha256:<hex>`.
 * - `skipped_google_native` — Google-native types
 *   (`application/vnd.google-apps.*`) need export, not download.
 *   Item lands as `google.drive.file`, `blob_ref` absent.
 * - `oversize` — file exceeds the configured per-file ceiling.
 *   Item lands as `google.drive.file`, `blob_ref` absent. Operator
 *   may raise `max_file_size_bytes` if they want to ingest these.
 * - `download_failed` — proxy non-2xx or network error. Item lands
 *   as `google.drive.file`, `blob_ref` absent. Next sync retries.
 */
interface BlobOutcomeCounts {
  files_with_blob: number;
  skipped_google_native: number;
  oversize: number;
  download_failed: number;
}

function emptyBlobOutcomes(): BlobOutcomeCounts {
  return {
    files_with_blob: 0,
    skipped_google_native: 0,
    oversize: 0,
    download_failed: 0,
  };
}

function addBlobOutcomes(
  into: BlobOutcomeCounts,
  from: BlobOutcomeCounts,
): void {
  into.files_with_blob += from.files_with_blob;
  into.skipped_google_native += from.skipped_google_native;
  into.oversize += from.oversize;
  into.download_failed += from.download_failed;
}

async function initialFilesListSweep(
  ctx: ConnectionContext,
  cursor: DriveCursor,
  config: ConnectionConfig,
): Promise<SweepCounts> {
  let upserted = 0;
  let skipped = 0;
  const trashed = 0;
  const blobs = emptyBlobOutcomes();
  let pageToken: string | undefined;
  let pages = 0;

  while (pages < INITIAL_SYNC_PAGE_LIMIT) {
    const params = new URLSearchParams();
    params.set("pageSize", String(FILES_PAGE_SIZE));
    params.set("q", "trashed=false");
    params.set("fields", `nextPageToken,files(${FILES_FIELDS})`);
    if (pageToken !== undefined) params.set("pageToken", pageToken);
    const path = `${DRIVE_API_BASE}/files?${params.toString()}`;

    let resp: Response;
    try {
      resp = await ctx.marfa.proxyRequest("GET", path);
    } catch (err) {
      await ctx.activity.emit({
        severity: "action_required",
        summary: "google-drive: files.list fetch failed during seed",
        detail: { error: errorMessage(err) },
      });
      return { upserted, skipped, trashed, blobs };
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      await ctx.activity.emit({
        severity: "action_required",
        summary: `google-drive: files.list returned ${String(resp.status)} during seed`,
        detail: { status: resp.status, response_text: text.slice(0, 500) },
      });
      return { upserted, skipped, trashed, blobs };
    }
    let payload: FilesListResponse;
    try {
      payload = await resp.json();
    } catch (err) {
      await ctx.activity.emit({
        severity: "action_required",
        summary: "google-drive: files.list parse failed during seed",
        detail: { error: errorMessage(err) },
      });
      return { upserted, skipped, trashed, blobs };
    }
    for (const file of payload.files ?? []) {
      const hash = contentHashForFile(file);
      if (await ctx.echo.shouldSkipReactive(file.id, hash)) {
        skipped += 1;
        continue;
      }
      const blob = await ingestBlobIfNeeded(ctx, file, config);
      tallyBlobOutcome(blobs, blob);
      const input = buildFileInput(file, config.target_type, blob);
      try {
        const marfa_id = cursor.mappings[file.id];
        if (marfa_id !== undefined) {
          await ctx.marfa.updateItem(marfa_id, input);
        } else {
          const created = await ctx.marfa.createItem({
            ...input,
            source_id: file.id,
          });
          cursor.mappings[file.id] = created.id;
        }
        upserted += 1;
      } catch (err) {
        await ctx.activity.emit({
          severity: "action_required",
          summary: `google-drive: upsert failed for file ${file.id} during seed`,
          detail: { error: errorMessage(err) },
        });
      }
    }
    if (typeof payload.nextPageToken !== "string") break;
    pageToken = payload.nextPageToken;
    pages += 1;
  }

  return { upserted, skipped, trashed, blobs };
}

async function applyChange(
  ctx: ConnectionContext,
  cursor: DriveCursor,
  change: DriveChange,
  config: ConnectionConfig,
): Promise<SweepCounts> {
  const fileId = change.fileId ?? change.file?.id;
  if (typeof fileId !== "string")
    return { upserted: 0, skipped: 0, trashed: 0, blobs: emptyBlobOutcomes() };

  const marfa_id = cursor.mappings[fileId];

  // Tombstone: removed OR trashed.
  if (change.removed === true || change.file?.trashed === true) {
    if (marfa_id !== undefined) {
      try {
        await ctx.marfa.transitionItem(marfa_id, "trashed");
        Reflect.deleteProperty(cursor.mappings, fileId);
        return {
          upserted: 0,
          skipped: 0,
          trashed: 1,
          blobs: emptyBlobOutcomes(),
        };
      } catch (err) {
        await ctx.activity.emit({
          severity: "action_required",
          summary: `google-drive: trash failed for ${fileId}`,
          detail: { error: errorMessage(err) },
        });
      }
    }
    return { upserted: 0, skipped: 0, trashed: 0, blobs: emptyBlobOutcomes() };
  }

  const file = change.file;
  if (file === undefined)
    return { upserted: 0, skipped: 0, trashed: 0, blobs: emptyBlobOutcomes() };

  const hash = contentHashForFile(file);
  if (await ctx.echo.shouldSkipReactive(fileId, hash)) {
    return { upserted: 0, skipped: 1, trashed: 0, blobs: emptyBlobOutcomes() };
  }

  const blobs = emptyBlobOutcomes();
  const blob = await ingestBlobIfNeeded(ctx, file, config);
  tallyBlobOutcome(blobs, blob);
  const input = buildFileInput(file, config.target_type, blob);
  try {
    if (marfa_id !== undefined) {
      await ctx.marfa.updateItem(marfa_id, input);
    } else {
      const created = await ctx.marfa.createItem({
        ...input,
        source_id: fileId,
      });
      cursor.mappings[fileId] = created.id;
    }
    return { upserted: 1, skipped: 0, trashed: 0, blobs };
  } catch (err) {
    await ctx.activity.emit({
      severity: "action_required",
      summary: `google-drive: upsert failed for ${fileId}`,
      detail: { error: errorMessage(err) },
    });
    return { upserted: 0, skipped: 0, trashed: 0, blobs };
  }
}

// ---------------------------------------------------------------------------
// changes.watch — zero-downtime renewal cron mirroring Calendar's shape.
// ---------------------------------------------------------------------------

function randomChannelId(): string {
  return globalThis.crypto.randomUUID();
}

function randomChannelToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function ensureChannel(
  ctx: ConnectionContext,
  cursor: DriveCursor,
  inboundWebhookUrl: string,
): Promise<void> {
  cursor.retired_channels = cursor.retired_channels ?? [];
  const now = Date.now();
  const existing = cursor.channel;
  const needsCreate = existing === undefined;
  const needsRenew =
    existing !== undefined &&
    existing.expiration_ms - now < CHANNEL_RENEW_LEEWAY_MS;
  if (!needsCreate && !needsRenew) return;

  const fresh = await createChannel(ctx, cursor, inboundWebhookUrl);
  if (fresh === null) return;
  if (existing !== undefined) {
    cursor.retired_channels.push(existing);
  }
  cursor.channel = fresh;

  // Drain retired channels best-effort.
  const retired = cursor.retired_channels;
  cursor.retired_channels = [];
  for (const old of retired) {
    await stopChannel(ctx, old);
  }
}

async function createChannel(
  ctx: ConnectionContext,
  cursor: DriveCursor,
  inboundWebhookUrl: string,
): Promise<ChannelState | null> {
  // Drive requires a fresh `pageToken` to anchor the watch — use the
  // current cursor's pageToken (or a freshly-fetched startPageToken
  // if the cursor isn't seeded yet).
  let pageToken = cursor.pageToken;
  if (pageToken === null) {
    const tokenResp = await ctx.marfa.proxyRequest(
      "GET",
      `${DRIVE_API_BASE}/changes/startPageToken`,
    );
    if (!tokenResp.ok) {
      await ctx.activity.emit({
        severity: "action_required",
        summary:
          "google-drive: startPageToken fetch failed during channel create",
        detail: { status: tokenResp.status },
      });
      return null;
    }
    const tokenBody: StartPageTokenResponse = await tokenResp.json();
    if (typeof tokenBody.startPageToken !== "string") return null;
    pageToken = tokenBody.startPageToken;
    cursor.pageToken = pageToken;
  }

  const channelId = randomChannelId();
  const channelToken = randomChannelToken();
  const expirationMs = Date.now() + CHANNEL_TTL_MS;
  const body = {
    id: channelId,
    type: "webhook",
    address: inboundWebhookUrl,
    token: channelToken,
    expiration: String(expirationMs),
  };
  const params = new URLSearchParams();
  params.set("pageToken", pageToken);
  const path = `${DRIVE_API_BASE}/changes/watch?${params.toString()}`;
  let resp: Response;
  try {
    resp = await ctx.marfa.proxyRequest("POST", path, body);
  } catch (err) {
    await ctx.activity.emit({
      severity: "action_required",
      summary: "google-drive: changes.watch fetch failed",
      detail: { error: errorMessage(err) },
    });
    return null;
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    await ctx.activity.emit({
      severity: "action_required",
      summary: `google-drive: changes.watch returned ${String(resp.status)}`,
      detail: { status: resp.status, response_text: text.slice(0, 500) },
    });
    return null;
  }
  interface WatchResponse {
    id?: string;
    resourceId?: string;
    expiration?: string;
  }
  const payload: WatchResponse = await resp.json();
  if (typeof payload.resourceId !== "string") return null;
  const resourceId: string = payload.resourceId;
  const expFromGoogle =
    typeof payload.expiration === "string"
      ? Number(payload.expiration)
      : expirationMs;
  return {
    channel_id: channelId,
    resource_id: resourceId,
    expiration_ms: Number.isFinite(expFromGoogle)
      ? expFromGoogle
      : expirationMs,
    channel_token: channelToken,
  };
}

async function stopChannel(
  ctx: ConnectionContext,
  channel: ChannelState,
): Promise<void> {
  try {
    const resp = await ctx.marfa.proxyRequest(
      "POST",
      `${DRIVE_API_BASE}/channels/stop`,
      { id: channel.channel_id, resourceId: channel.resource_id },
    );
    if (!resp.ok && resp.status !== 404 && resp.status !== 410) {
      const text = await resp.text().catch(() => "");
      await ctx.activity.emit({
        severity: "info",
        summary: `google-drive: channels.stop returned ${String(resp.status)} for ${channel.channel_id} (best-effort)`,
        detail: { status: resp.status, response_text: text.slice(0, 300) },
      });
    }
  } catch (err) {
    await ctx.activity.emit({
      severity: "info",
      summary: `google-drive: channels.stop fetch failed for ${channel.channel_id} (best-effort)`,
      detail: { error: errorMessage(err) },
    });
  }
}

/**
 * Webhook handler for Drive push notifications. Body is empty by
 * design — Google sends `X-Goog-Resource-State` and friends. Handler
 * re-drives `handleSchedule`'s incremental path so push and poll
 * converge.
 */
export async function handleWebhook(
  ctx: ConnectionContext,
  input: WebhookHandlerInput,
): Promise<HandlerResult> {
  const state =
    input.headers["x-goog-resource-state"] ??
    input.headers["X-Goog-Resource-State"];
  if (state === "sync") {
    // Initial handshake Google sends right after channel creation.
    return { ok: true };
  }
  return handleSchedule(ctx, {
    kind: "schedule",
    integration_name: "google.drive",
    connection_id: ctx.connection_id,
    scheduled_for_ms: Date.now(),
  });
}

/**
 * Outbound handler — defensive no-op. Direction is `inbound` so the
 * reactive bridge shouldn't dispatch us, but handler registration is
 * required by `createIntegrationWorker`'s queue topology.
 */
export async function handleItemEvent(
  ctx: ConnectionContext,
  message: ItemEventMessage,
): Promise<HandlerResult> {
  void ctx;
  void message;
  return Promise.resolve({ ok: true });
}

export function registerHandlers(): void {
  registerScheduleHandler(handleSchedule);
  registerItemEventHandler(handleItemEvent);
  registerWebhookHandler(handleWebhook);
}

/**
 * Outcome of attempting to ingest a Drive file's bytes into the
 * Marfa blob store (T-239). Drives both the per-run counters and the
 * `targetType` decision in `buildFileInput` — `core.file` requires
 * a `blob_ref`, so we only emit it on `ingested`; every other
 * outcome routes to `google.drive.file` with `blob_ref` absent.
 */
type BlobIngestOutcome =
  | { status: "ingested"; hash: string; size: number }
  | { status: "skipped_metadata" }
  | { status: "skipped_google_native" }
  | { status: "skipped_oversize"; size: number; ceiling: number }
  | { status: "download_failed"; reason: string };

function tallyBlobOutcome(
  counts: BlobOutcomeCounts,
  outcome: BlobIngestOutcome,
): void {
  switch (outcome.status) {
    case "ingested":
      counts.files_with_blob += 1;
      return;
    case "skipped_google_native":
      counts.skipped_google_native += 1;
      return;
    case "skipped_oversize":
      counts.oversize += 1;
      return;
    case "download_failed":
      counts.download_failed += 1;
      return;
    case "skipped_metadata":
      return;
  }
}

function isGoogleNativeMime(mimeType: string | undefined): boolean {
  return (
    typeof mimeType === "string" &&
    mimeType.startsWith("application/vnd.google-apps.")
  );
}

function parseDriveSize(raw: string | undefined): number | null {
  if (typeof raw !== "string") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Decide whether to ingest a Drive file's bytes into the Marfa blob
 * store, and (if so) do it. Pure metadata mode short-circuits to
 * `skipped_metadata`. In all-files mode the path is:
 *
 *   1. Google-native files (`application/vnd.google-apps.*`) need
 *      export, not download — return `skipped_google_native` and
 *      emit no per-file activity (the roll-up summary counts them).
 *   2. Files whose declared size exceeds the per-file ceiling
 *      return `skipped_oversize` and emit a per-file `info` row so
 *      the operator can see which files were skipped + why.
 *   3. Files within ceiling: proxy `GET /drive/v3/files/{id}?alt=media`,
 *      buffer the bytes, then `ctx.marfa.uploadBlob({ content,
 *      mime_type })`. On any proxy / network / SDK failure return
 *      `download_failed` and emit a per-file `info` row. The next
 *      schedule run will retry naturally — `info` rather than
 *      `action_required` because transient failures don't require
 *      operator intervention; we follow the neighbour-integration
 *      convention (rss-watcher, task-auto-archive,
 *      google-calendar) of reserving `action_required` for
 *      operator-actionable failures (reauth, credential rejection).
 */
async function ingestBlobIfNeeded(
  ctx: ConnectionContext,
  file: DriveFile,
  config: ConnectionConfig,
): Promise<BlobIngestOutcome> {
  if (config.download_mode !== "all-files") {
    return { status: "skipped_metadata" };
  }
  if (isGoogleNativeMime(file.mimeType)) {
    return { status: "skipped_google_native" };
  }
  const size = parseDriveSize(file.size);
  if (size !== null && size > config.max_file_size_bytes) {
    await ctx.activity.emit({
      severity: "info",
      summary: `google-drive: skipped oversize file ${file.id} (${String(size)} > ${String(config.max_file_size_bytes)} bytes)`,
      detail: {
        drive_file_id: file.id,
        title: file.name,
        size_bytes: size,
        ceiling_bytes: config.max_file_size_bytes,
      },
    });
    return {
      status: "skipped_oversize",
      size,
      ceiling: config.max_file_size_bytes,
    };
  }
  // Bytes pass via the OAuth proxy — same credential the rest of
  // the integration uses; no separate plumbing needed.
  const mimeType = file.mimeType ?? "application/octet-stream";
  let resp: Response;
  try {
    resp = await ctx.marfa.proxyRequest(
      "GET",
      `${DRIVE_API_BASE}/files/${file.id}?alt=media`,
    );
  } catch (err) {
    return reportBlobDownloadFailure(
      ctx,
      file,
      `proxy fetch failed: ${errorMessage(err)}`,
    );
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return reportBlobDownloadFailure(
      ctx,
      file,
      `proxy returned ${String(resp.status)}: ${body.slice(0, 200)}`,
    );
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await resp.arrayBuffer();
  } catch (err) {
    return reportBlobDownloadFailure(
      ctx,
      file,
      `arrayBuffer parse failed: ${errorMessage(err)}`,
    );
  }
  try {
    const result = await ctx.marfa.uploadBlob({
      content: bytes,
      mime_type: mimeType,
    });
    return {
      status: "ingested",
      hash: result.hash,
      size: result.size,
    };
  } catch (err) {
    return reportBlobDownloadFailure(
      ctx,
      file,
      `uploadBlob failed: ${errorMessage(err)}`,
    );
  }
}

async function reportBlobDownloadFailure(
  ctx: ConnectionContext,
  file: DriveFile,
  reason: string,
): Promise<BlobIngestOutcome> {
  await ctx.activity.emit({
    severity: "info",
    summary: `google-drive: download failed for ${file.id}; will retry on next sync`,
    detail: {
      drive_file_id: file.id,
      title: file.name,
      reason,
    },
  });
  return { status: "download_failed", reason };
}

function buildFileInput(
  file: DriveFile,
  configuredTargetType: string,
  blob: BlobIngestOutcome,
): CreateItemInput {
  const properties: Record<string, unknown> = {
    title: file.name ?? "Untitled file",
    mime_type: file.mimeType ?? "application/octet-stream",
    drive_file_id: file.id,
  };
  if (typeof file.size === "string") {
    const n = Number(file.size);
    if (Number.isFinite(n)) properties.size_bytes = n;
  }
  if (file.createdTime !== undefined)
    properties.created_at_drive = file.createdTime;
  if (file.modifiedTime !== undefined)
    properties.modified_at_drive = file.modifiedTime;
  if (Array.isArray(file.owners) && file.owners.length > 0) {
    const emails = file.owners
      .map((o) => o.emailAddress)
      .filter((e): e is string => typeof e === "string");
    if (emails.length > 0) properties.owners = emails;
  }
  if (Array.isArray(file.parents)) properties.parents = file.parents;
  if (file.trashed !== undefined) properties.trashed = file.trashed;
  if (file.webViewLink !== undefined)
    properties.web_view_link = file.webViewLink;
  if (file.iconLink !== undefined) properties.icon_link = file.iconLink;
  if (file.thumbnailLink !== undefined)
    properties.thumbnail_link = file.thumbnailLink;
  if (file.md5Checksum !== undefined)
    properties.md5_checksum = file.md5Checksum;
  if (file.sha256Checksum !== undefined)
    properties.sha256_checksum = file.sha256Checksum;
  if (file.etag !== undefined) properties.etag = file.etag;

  // Type-routing: `blob_ref` means "bytes retrievable from the Marfa
  // blob store" (T-239). `core.file` requires it; `google.drive.file`
  // accepts it as optional. We emit `core.file` only when bytes were
  // successfully ingested; every other path routes to
  // `google.drive.file` with `blob_ref` absent. The
  // `configuredTargetType` is the operator's preferred default — we
  // downgrade away from `core.file` rather than synthesise a fake
  // `blob_ref` that doesn't resolve via `GET /blobs/{ref}`.
  if (blob.status === "ingested") {
    properties.blob_ref = blob.hash;
    if (file.webViewLink !== undefined) properties.url = file.webViewLink;
    // Honour `core.file` when the bytes are real; otherwise prefer
    // `google.drive.file` for the fuller fidelity (Drive-specific
    // fields like `drive_file_id`, `web_view_link`).
    const type =
      configuredTargetType === "core.file" ? "core.file" : DEFAULT_TARGET_TYPE;
    return { type, properties };
  }

  return { type: DEFAULT_TARGET_TYPE, properties };
}

function contentHashForFile(file: DriveFile): string {
  if (typeof file.etag === "string" && file.etag.length > 0) return file.etag;
  if (typeof file.modifiedTime === "string") return file.modifiedTime;
  return [
    file.id,
    file.name ?? "",
    file.mimeType ?? "",
    file.size ?? "",
    file.trashed ?? false,
  ].join("|");
}

async function reportFailure(
  ctx: ConnectionContext,
  summary: string,
  err: unknown,
  retry: boolean,
): Promise<HandlerResult> {
  await ctx.activity.emit({
    severity: "action_required",
    summary: `google-drive: ${summary}`,
    detail: err === null ? undefined : { error: errorMessage(err) },
  });
  if (retry) return { ok: false, retry: true, reason: summary };
  return { ok: true };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

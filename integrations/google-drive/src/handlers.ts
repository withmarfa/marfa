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
 *     true` surfaces as a Myme tombstone on the mapped item.
 *   - **No outbound writes in v1.** `direction: "inbound"` on the
 *     manifest; `handleItemEvent` is a defensive no-op that just
 *     filters self-events.
 *
 * **Blob handling — metadata-only in v1.** The `download_mode`
 * configuration field is declared but only the default `metadata`
 * mode is wired today. `all-files` and `glob:<pattern>` would
 * require a `ConnectionClient.uploadBlob` primitive that does not
 * yet exist on `@mymehq/runtime-sdk` — flagged as the v1.1 substrate
 * dependency in `CLAUDE.md`.
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
} from "@mymehq/runtime-sdk";
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
  /** Drive file id → Myme item id. */
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
  /** `metadata` | `all-files` | `glob:<pattern>`. Only `metadata` is
   *  wired in v1; the other values flow through and emit an
   *  `action_required` note. Typed as `string` because `glob:<pattern>`
   *  is open-ended. */
  download_mode: string;
  /** Set when an inbound webhook subscription has been minted at
   *  install time; enables push notifications. */
  inbound_webhook_url: string | null;
}

async function resolveConnectionConfig(
  ctx: ConnectionContext,
): Promise<ConnectionConfig> {
  try {
    const connection = await ctx.myme.getItem(ctx.connection_id);
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
    return {
      target_type: targetType,
      download_mode: downloadMode,
      inbound_webhook_url: inboundUrl,
    };
  } catch {
    return {
      target_type: DEFAULT_TARGET_TYPE,
      download_mode: "metadata",
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

  // Cold start: seed pageToken + initial files.list pass.
  if (!cursor.seeded || cursor.pageToken === null) {
    const tokenResp = await ctx.myme.proxyRequest(
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
      resp = await ctx.myme.proxyRequest("GET", path);
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

  await ctx.activity.emit({
    severity: "info",
    summary: `google-drive inbound: upserted=${String(totalUpserted)} echo_skipped=${String(totalSkippedEcho)} trashed=${String(totalTrashed)}${config.download_mode !== "metadata" ? ` (download_mode=${config.download_mode} — METADATA-ONLY in v1; substrate gap)` : ""}`,
    detail: {
      upserted: totalUpserted,
      skipped_echo: totalSkippedEcho,
      trashed: totalTrashed,
      download_mode: config.download_mode,
    },
  });

  return { ok: true };
}

interface SweepCounts {
  upserted: number;
  skipped: number;
  trashed: number;
}

async function initialFilesListSweep(
  ctx: ConnectionContext,
  cursor: DriveCursor,
  config: ConnectionConfig,
): Promise<SweepCounts> {
  let upserted = 0;
  let skipped = 0;
  const trashed = 0;
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
      resp = await ctx.myme.proxyRequest("GET", path);
    } catch (err) {
      await ctx.activity.emit({
        severity: "action_required",
        summary: "google-drive: files.list fetch failed during seed",
        detail: { error: errorMessage(err) },
      });
      return { upserted, skipped, trashed };
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      await ctx.activity.emit({
        severity: "action_required",
        summary: `google-drive: files.list returned ${String(resp.status)} during seed`,
        detail: { status: resp.status, response_text: text.slice(0, 500) },
      });
      return { upserted, skipped, trashed };
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
      return { upserted, skipped, trashed };
    }
    for (const file of payload.files ?? []) {
      const hash = contentHashForFile(file);
      if (await ctx.echo.shouldSkipReactive(file.id, hash)) {
        skipped += 1;
        continue;
      }
      const input = buildFileInput(file, config.target_type);
      try {
        const myme_id = cursor.mappings[file.id];
        if (myme_id !== undefined) {
          await ctx.myme.updateItem(myme_id, input);
        } else {
          const created = await ctx.myme.createItem({
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

  return { upserted, skipped, trashed };
}

async function applyChange(
  ctx: ConnectionContext,
  cursor: DriveCursor,
  change: DriveChange,
  config: ConnectionConfig,
): Promise<SweepCounts> {
  const fileId = change.fileId ?? change.file?.id;
  if (typeof fileId !== "string")
    return { upserted: 0, skipped: 0, trashed: 0 };

  const myme_id = cursor.mappings[fileId];

  // Tombstone: removed OR trashed.
  if (change.removed === true || change.file?.trashed === true) {
    if (myme_id !== undefined) {
      try {
        await ctx.myme.transitionItem(myme_id, "trashed");
        Reflect.deleteProperty(cursor.mappings, fileId);
        return { upserted: 0, skipped: 0, trashed: 1 };
      } catch (err) {
        await ctx.activity.emit({
          severity: "action_required",
          summary: `google-drive: trash failed for ${fileId}`,
          detail: { error: errorMessage(err) },
        });
      }
    }
    return { upserted: 0, skipped: 0, trashed: 0 };
  }

  const file = change.file;
  if (file === undefined) return { upserted: 0, skipped: 0, trashed: 0 };

  const hash = contentHashForFile(file);
  if (await ctx.echo.shouldSkipReactive(fileId, hash)) {
    return { upserted: 0, skipped: 1, trashed: 0 };
  }

  const input = buildFileInput(file, config.target_type);
  try {
    if (myme_id !== undefined) {
      await ctx.myme.updateItem(myme_id, input);
    } else {
      const created = await ctx.myme.createItem({
        ...input,
        source_id: fileId,
      });
      cursor.mappings[fileId] = created.id;
    }
    return { upserted: 1, skipped: 0, trashed: 0 };
  } catch (err) {
    await ctx.activity.emit({
      severity: "action_required",
      summary: `google-drive: upsert failed for ${fileId}`,
      detail: { error: errorMessage(err) },
    });
    return { upserted: 0, skipped: 0, trashed: 0 };
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
    const tokenResp = await ctx.myme.proxyRequest(
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
    resp = await ctx.myme.proxyRequest("POST", path, body);
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
    const resp = await ctx.myme.proxyRequest(
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

function buildFileInput(file: DriveFile, targetType: string): CreateItemInput {
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

  if (targetType === "core.file") {
    // core.file needs blob_ref + mime_type; without uploadBlob we
    // can't populate blob_ref, so for core.file in metadata mode we
    // synthesise a placeholder reference using sha256Checksum when
    // present (callers know v1 is metadata-only).
    if (typeof file.sha256Checksum === "string") {
      properties.blob_ref = `sha256:${file.sha256Checksum}`;
    } else if (typeof file.md5Checksum === "string") {
      properties.blob_ref = `md5:${file.md5Checksum}`;
    } else {
      // Fall back to the drive id as a stable but non-content-addressed
      // reference so the required field is satisfied; this signals
      // "metadata-only mode" to a careful reader.
      properties.blob_ref = `drive:${file.id}`;
    }
    if (file.webViewLink !== undefined) properties.url = file.webViewLink;
    return { type: targetType, properties };
  }

  return { type: targetType, properties };
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

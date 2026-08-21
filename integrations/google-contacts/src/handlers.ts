/**
 * Google Contacts (People API) bidirectional handlers.
 *
 * People API differs from Calendar / Tasks in three ways the handler
 * has to honor:
 *
 *   - **syncToken with full re-list on 410.** `connections.list`
 *     returns a `nextSyncToken`; passing it back yields incremental
 *     mutations only. After ~7 days idle (or any time Google
 *     invalidates), a follow-up call with the stale token returns
 *     `410 Gone`. Handler resets the token and does a fresh full
 *     list on the next sweep.
 *   - **personFields mask is mandatory.** Every read passes
 *     `PERSON_FIELDS`; the comprehensive shape is documented on the
 *     manifest.
 *   - **etag-based optimistic concurrency on updates.** Every
 *     update PATCH carries the etag the handler last saw; stale
 *     etag returns 409, the handler refetches and reapplies once.
 *
 * Same `bidirectional_handling` defaults as Calendar / Tasks. Same
 * cursor-mappings shape (resource_name -> marfa_id). No second-level
 * scoping (Tasks' per-list, Calendar's per-calendar) — every contact
 * lives in the single "connections" collection.
 *
 * Outbound idempotency-on-retry: People API does NOT accept a
 * client-supplied id on `createContact`. The handler stores the
 * Marfa item id in a `clientData` entry on the person —
 * `{ key: "marfa-id", value: "<itemId>" }` — and on retry searches
 * the connections list for an existing person carrying that
 * clientData marker before issuing a fresh insert.
 */
import {
  registerScheduleHandler,
  registerItemEventHandler,
  type ConnectionContext,
  type ScheduleMessage,
  type ItemEventMessage,
  type HandlerResult,
  type CreateItemInput,
  type ItemResource,
} from "@withmarfa/runtime-sdk";
import { resolveWriteFamily } from "@withmarfa/shared";
import {
  DEFAULT_WRITE_FAMILY,
  GOOGLE_CONTACTS_MANIFEST,
  PEOPLE_API_BASE,
  PERSON_FIELDS,
  UPDATE_PERSON_FIELDS,
  FAMILY_DEFINITIONS,
} from "./manifest.js";

const CURSOR_KEY = "main";

/** Pagesize for connections.list reads. People API maxes at 1000. */
const PAGE_SIZE = 200;

/** Hard cap on idempotency-search pages. */
const SENTINEL_SEARCH_PAGE_LIMIT = 6;

/** clientData key used to thread the Marfa item id onto a created
 *  contact for idempotency-on-retry recovery. */
const MARFA_ID_CLIENT_DATA_KEY = "marfa-id";

interface ContactsCursor {
  /** People API `resourceName` (e.g. `people/c123`) -> Marfa item id. */
  mappings: Record<string, string>;
  /** Opaque syncToken. Null on cold start AND after a 410. */
  syncToken: string | null;
  /** Diagnostic — last successful sweep timestamp. */
  last_inbound_at: string | null;
}

interface ConnectionConfig {
  /** Type inbound contacts land as: the contact role of the connection's
   *  resolved write family. */
  target_type: string;
}

const DEFAULT_CONTACT_TYPE =
  FAMILY_DEFINITIONS[DEFAULT_WRITE_FAMILY].types.contact;

async function resolveConnectionConfig(
  ctx: ConnectionContext,
): Promise<ConnectionConfig> {
  try {
    const connection = await ctx.marfa.getItem(ctx.connection_id);
    const props = connection?.properties as
      | { configuration?: Record<string, unknown> }
      | undefined;
    const cfg = props?.configuration ?? {};
    // The manifest's declared families decide the type: a configured
    // `write_family` names one, and an unconfigured connection gets the
    // declared default.
    const family = resolveWriteFamily(GOOGLE_CONTACTS_MANIFEST, cfg);
    return { target_type: family?.types.contact ?? DEFAULT_CONTACT_TYPE };
  } catch {
    return { target_type: DEFAULT_CONTACT_TYPE };
  }
}

interface PersonName {
  givenName?: string;
  familyName?: string;
  middleName?: string;
  honorificPrefix?: string;
  honorificSuffix?: string;
  displayName?: string;
}

interface PersonField {
  value?: string;
  type?: string;
  formattedType?: string;
}

interface PersonAddress {
  formattedValue?: string;
  type?: string;
  streetAddress?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  countryCode?: string;
}

interface PersonOrganization {
  name?: string;
  title?: string;
  department?: string;
}

interface PersonBiography {
  value?: string;
  contentType?: string;
}

interface PersonPhoto {
  url?: string;
  default?: boolean;
}

interface PersonBirthday {
  date?: { year?: number; month?: number; day?: number };
  text?: string;
}

interface PersonClientData {
  key?: string;
  value?: string;
}

interface PersonMetadata {
  deleted?: boolean;
  sources?: { etag?: string; type?: string }[];
}

interface PersonResource {
  resourceName: string;
  etag?: string;
  metadata?: PersonMetadata;
  names?: PersonName[];
  nicknames?: PersonField[];
  emailAddresses?: PersonField[];
  phoneNumbers?: PersonField[];
  addresses?: PersonAddress[];
  organizations?: PersonOrganization[];
  biographies?: PersonBiography[];
  photos?: PersonPhoto[];
  birthdays?: PersonBirthday[];
  clientData?: PersonClientData[];
}

interface ConnectionsListResponse {
  connections?: PersonResource[];
  nextPageToken?: string;
  nextSyncToken?: string;
  totalPeople?: number;
}

export async function handleSchedule(
  ctx: ConnectionContext,
  message: ScheduleMessage,
): Promise<HandlerResult> {
  void message;
  const config = await resolveConnectionConfig(ctx);
  const cursor: ContactsCursor = ((await ctx.cursor.read(
    CURSOR_KEY,
  )) as ContactsCursor | null) ?? {
    mappings: {},
    syncToken: null,
    last_inbound_at: null,
  };

  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;
  let upserted = 0;
  let skippedEcho = 0;
  let trashed = 0;
  let resetOn410 = false;

  // `for(;;)` with explicit `break` rather than `do { } while
  // (pageToken !== undefined)`: the 410 recovery path needs to
  // continue the loop even when pageToken is undefined (we just
  // dropped the stale syncToken and want a fresh list call without
  // pagination). A do-while keyed on pageToken would exit silently.
  for (;;) {
    const params = new URLSearchParams();
    params.set("personFields", PERSON_FIELDS);
    params.set("pageSize", String(PAGE_SIZE));
    params.set("requestSyncToken", "true");
    if (cursor.syncToken !== null && !resetOn410) {
      params.set("syncToken", cursor.syncToken);
    }
    if (pageToken !== undefined) params.set("pageToken", pageToken);
    const path = `${PEOPLE_API_BASE}/people/me/connections?${params.toString()}`;

    let response: Response;
    try {
      response = await ctx.marfa.proxyRequest("GET", path);
    } catch (err) {
      return reportFailure(
        ctx,
        "people.connections.list fetch failed",
        err,
        true,
      );
    }

    if (response.status === 410) {
      cursor.syncToken = null;
      pageToken = undefined;
      resetOn410 = true;
      await ctx.activity.emit({
        severity: "info",
        summary:
          "google-contacts: syncToken invalidated (410), re-bootstrapping with a full list",
      });
      continue;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return reportFailure(
        ctx,
        `people.connections.list returned ${String(response.status)}`,
        new Error(text.slice(0, 500)),
        response.status >= 500,
      );
    }

    let payload: ConnectionsListResponse;
    try {
      payload = await response.json();
    } catch (err) {
      return reportFailure(
        ctx,
        "people.connections.list parse failed",
        err,
        true,
      );
    }

    for (const person of payload.connections ?? []) {
      const resourceName = person.resourceName;
      const marfa_id = cursor.mappings[resourceName];

      if (person.metadata?.deleted === true) {
        if (marfa_id !== undefined) {
          try {
            await ctx.marfa.transitionItem(marfa_id, "trashed");
            trashed += 1;
            Reflect.deleteProperty(cursor.mappings, resourceName);
          } catch (err) {
            await ctx.activity.emit({
              severity: "action_required",
              summary: `google-contacts: trash failed for ${resourceName}`,
              detail: { error: errorMessage(err) },
            });
          }
        }
        continue;
      }

      const hash = contentHashForPerson(person);
      if (await ctx.echo.shouldSkipReactive(resourceName, hash)) {
        skippedEcho += 1;
        continue;
      }

      const input = buildPersonInput(person, config.target_type);
      try {
        if (marfa_id !== undefined) {
          await ctx.marfa.updateItem(marfa_id, input);
        } else {
          const created = await ctx.marfa.createItem({
            ...input,
            source_id: resourceName,
          });
          cursor.mappings[resourceName] = created.id;
        }
        upserted += 1;
      } catch (err) {
        await ctx.activity.emit({
          severity: "action_required",
          summary: `google-contacts: upsert failed for ${resourceName}`,
          detail: { error: errorMessage(err) },
        });
      }
    }

    if (typeof payload.nextSyncToken === "string") {
      nextSyncToken = payload.nextSyncToken;
    }
    pageToken = payload.nextPageToken;
    if (pageToken === undefined) break;
  }

  if (nextSyncToken !== null) {
    cursor.syncToken = nextSyncToken;
  }
  cursor.last_inbound_at = new Date().toISOString();
  await ctx.cursor.write(CURSOR_KEY, cursor);

  await ctx.activity.emit({
    severity: "info",
    summary: `google-contacts inbound: upserted=${String(upserted)} echo_skipped=${String(skippedEcho)} trashed=${String(trashed)}${resetOn410 ? " (syncToken-reset)" : ""}`,
    detail: {
      upserted,
      skipped_echo: skippedEcho,
      trashed,
      reset_on_410: resetOn410,
    },
  });

  return { ok: true };
}

export async function handleItemEvent(
  ctx: ConnectionContext,
  message: ItemEventMessage,
): Promise<HandlerResult> {
  if (
    ctx.cycle?.originating_connection_id === ctx.connection_id ||
    message.cycle.originating_connection_id === ctx.connection_id
  ) {
    return { ok: true };
  }

  const cursor: ContactsCursor = ((await ctx.cursor.read(
    CURSOR_KEY,
  )) as ContactsCursor | null) ?? {
    mappings: {},
    syncToken: null,
    last_inbound_at: null,
  };

  const item = await ctx.marfa.getItem(message.item_id);
  if (item === null) {
    return ackHandledIfMappedAsDelete(ctx, cursor, message.item_id);
  }

  const externalId = findExternalIdFor(cursor, item.id);

  if (externalId !== null && (await ctx.echo.inLagWindow(externalId))) {
    return { ok: false, retry: true, reason: "in_lag_window" };
  }

  if (item.state === "trashed") {
    if (externalId !== null) {
      const path = `${PEOPLE_API_BASE}/${encodeResourceName(externalId)}:deleteContact`;
      const resp = await ctx.marfa.proxyRequest("DELETE", path);
      if (!resp.ok && resp.status !== 404 && resp.status !== 410) {
        return reportOutboundFailure(ctx, "DELETE", externalId, resp);
      }
      Reflect.deleteProperty(cursor.mappings, externalId);
      await ctx.cursor.write(CURSOR_KEY, cursor);
      await ctx.activity.emit({
        severity: "info",
        summary: `google-contacts outbound: deleted contact ${externalId}`,
      });
    }
    return { ok: true };
  }

  if (externalId === null) {
    const existing = await findExistingByMarfaIdMarker(ctx, item.id);
    if (existing !== null) {
      cursor.mappings[existing.resourceName] = item.id;
      await ctx.echo.trackOutboundWrite(
        existing.resourceName,
        contentHashForPerson(existing),
      );
      await ctx.cursor.write(CURSOR_KEY, cursor);
      await ctx.activity.emit({
        severity: "info",
        summary: `google-contacts outbound: idempotent recovery for Marfa item ${item.id}`,
      });
      return { ok: true };
    }

    const payload = buildPeoplePayload(item);
    payload.clientData = [{ key: MARFA_ID_CLIENT_DATA_KEY, value: item.id }];
    const postPath = `${PEOPLE_API_BASE}/people:createContact?personFields=${encodeURIComponent(PERSON_FIELDS)}`;
    const resp = await ctx.marfa.proxyRequest("POST", postPath, payload);
    if (!resp.ok) {
      return reportOutboundFailure(ctx, "POST", "(new)", resp);
    }
    const body: PersonResource = await resp.json();
    cursor.mappings[body.resourceName] = item.id;
    await ctx.echo.trackOutboundWrite(
      body.resourceName,
      contentHashForPerson(body),
    );
    await ctx.cursor.write(CURSOR_KEY, cursor);
    await ctx.activity.emit({
      severity: "info",
      summary: `google-contacts outbound: created contact ${body.resourceName}`,
    });
    return { ok: true };
  }

  return updateContactWithRefetchOnStaleEtag(ctx, cursor, item, externalId);
}

async function updateContactWithRefetchOnStaleEtag(
  ctx: ConnectionContext,
  cursor: ContactsCursor,
  item: ItemResource,
  externalId: string,
  attemptCount = 0,
): Promise<HandlerResult> {
  void cursor;
  const payload = buildPeoplePayload(item);
  const props = item.properties as { etag?: unknown } | undefined;
  if (typeof props?.etag === "string") {
    payload.etag = props.etag;
  }
  const path = `${PEOPLE_API_BASE}/${encodeResourceName(externalId)}:updateContact?updatePersonFields=${encodeURIComponent(UPDATE_PERSON_FIELDS)}&personFields=${encodeURIComponent(PERSON_FIELDS)}`;
  const resp = await ctx.marfa.proxyRequest("PATCH", path, payload);

  if (resp.status === 409 && attemptCount === 0) {
    const getPath = `${PEOPLE_API_BASE}/${encodeResourceName(externalId)}?personFields=${encodeURIComponent(PERSON_FIELDS)}`;
    const getResp = await ctx.marfa.proxyRequest("GET", getPath);
    if (!getResp.ok) {
      return reportOutboundFailure(ctx, "GET (after 409)", externalId, getResp);
    }
    const fresh: PersonResource = await getResp.json();
    const itemWithFreshEtag: ItemResource = {
      ...item,
      properties: { ...item.properties, etag: fresh.etag ?? "" },
    };
    return updateContactWithRefetchOnStaleEtag(
      ctx,
      cursor,
      itemWithFreshEtag,
      externalId,
      1,
    );
  }

  if (!resp.ok) {
    return reportOutboundFailure(ctx, "PATCH", externalId, resp);
  }
  const body: PersonResource = await resp.json();
  await ctx.echo.trackOutboundWrite(externalId, contentHashForPerson(body));
  await ctx.activity.emit({
    severity: "info",
    summary: `google-contacts outbound: patched contact ${externalId}${attemptCount > 0 ? " (after etag refetch)" : ""}`,
  });
  return { ok: true };
}

export function registerHandlers(): void {
  registerScheduleHandler(handleSchedule);
  registerItemEventHandler(handleItemEvent);
}

async function findExistingByMarfaIdMarker(
  ctx: ConnectionContext,
  marfaItemId: string,
): Promise<PersonResource | null> {
  let pageToken: string | undefined;
  let pages = 0;
  while (pages < SENTINEL_SEARCH_PAGE_LIMIT) {
    const params = new URLSearchParams();
    params.set("personFields", `${PERSON_FIELDS},clientData`);
    params.set("pageSize", String(PAGE_SIZE));
    if (pageToken !== undefined) params.set("pageToken", pageToken);
    const path = `${PEOPLE_API_BASE}/people/me/connections?${params.toString()}`;
    let resp: Response;
    try {
      resp = await ctx.marfa.proxyRequest("GET", path);
    } catch {
      return null;
    }
    if (!resp.ok) return null;
    let payload: ConnectionsListResponse;
    try {
      payload = await resp.json();
    } catch {
      return null;
    }
    for (const person of payload.connections ?? []) {
      const cd = person.clientData;
      if (
        Array.isArray(cd) &&
        cd.some(
          (e) => e.key === MARFA_ID_CLIENT_DATA_KEY && e.value === marfaItemId,
        )
      ) {
        return person;
      }
    }
    if (typeof payload.nextPageToken !== "string") return null;
    pageToken = payload.nextPageToken;
    pages += 1;
  }
  return null;
}

function buildPersonInput(
  person: PersonResource,
  targetType: string,
): CreateItemInput {
  const name = person.names?.[0];
  const fallback =
    [name?.givenName, name?.familyName].filter(Boolean).join(" ").trim() ||
    "Unnamed contact";
  const display = name?.displayName ?? fallback;

  const properties: Record<string, unknown> = {
    title: display.length > 0 ? display : "Unnamed contact",
    resource_name: person.resourceName,
  };
  if (typeof person.etag === "string") properties.etag = person.etag;
  if (name?.givenName !== undefined) properties.given_name = name.givenName;
  if (name?.familyName !== undefined) properties.family_name = name.familyName;
  if (name?.middleName !== undefined) properties.middle_name = name.middleName;
  if (name?.honorificPrefix !== undefined)
    properties.prefix = name.honorificPrefix;
  if (name?.honorificSuffix !== undefined)
    properties.suffix = name.honorificSuffix;

  const nickname = person.nicknames?.[0]?.value;
  if (typeof nickname === "string") properties.nickname = nickname;

  if (
    Array.isArray(person.emailAddresses) &&
    person.emailAddresses.length > 0
  ) {
    properties.emails = person.emailAddresses.map((e) =>
      JSON.stringify({
        value: e.value ?? "",
        type: e.type ?? "",
        formattedType: e.formattedType ?? "",
      }),
    );
  }
  if (Array.isArray(person.phoneNumbers) && person.phoneNumbers.length > 0) {
    properties.phones = person.phoneNumbers.map((p) =>
      JSON.stringify({
        value: p.value ?? "",
        type: p.type ?? "",
        formattedType: p.formattedType ?? "",
      }),
    );
  }
  if (Array.isArray(person.addresses) && person.addresses.length > 0) {
    properties.addresses = person.addresses.map((a) => JSON.stringify(a));
  }

  const org = person.organizations?.[0];
  if (typeof org?.name === "string") properties.organization = org.name;
  if (typeof org?.title === "string") properties.job_title = org.title;
  if (typeof org?.department === "string")
    properties.department = org.department;

  const bio = person.biographies?.[0]?.value;
  if (typeof bio === "string") properties.biography = bio;

  const bday = person.birthdays?.[0]?.date;
  if (bday !== undefined) {
    const yearStr =
      typeof bday.year === "number" && bday.year > 0
        ? String(bday.year).padStart(4, "0")
        : "";
    const monthStr =
      typeof bday.month === "number" ? String(bday.month).padStart(2, "0") : "";
    const dayStr =
      typeof bday.day === "number" ? String(bday.day).padStart(2, "0") : "";
    const dateStr =
      yearStr !== ""
        ? `${yearStr}-${monthStr.length > 0 ? monthStr : "01"}-${dayStr.length > 0 ? dayStr : "01"}`
        : monthStr !== "" && dayStr !== ""
          ? `--${monthStr}-${dayStr}`
          : "";
    if (dateStr !== "") properties.birthday = dateStr;
  }

  const photoUrl =
    person.photos?.find((p) => p.default === true)?.url ??
    person.photos?.[0]?.url;
  if (typeof photoUrl === "string") properties.photo_url = photoUrl;

  if (targetType === "core.entity.person") {
    delete properties.emails;
    delete properties.phones;
    delete properties.addresses;
    delete properties.resource_name;
    delete properties.etag;
    delete properties.photo_url;
    return { type: targetType, properties };
  }

  return { type: targetType, properties };
}

function buildPeoplePayload(item: ItemResource): Record<string, unknown> {
  const props = item.properties ?? {};
  const payload: Record<string, unknown> = {};

  const name: PersonName = {};
  if (typeof props.given_name === "string") name.givenName = props.given_name;
  if (typeof props.family_name === "string")
    name.familyName = props.family_name;
  if (typeof props.middle_name === "string")
    name.middleName = props.middle_name;
  if (typeof props.prefix === "string") name.honorificPrefix = props.prefix;
  if (typeof props.suffix === "string") name.honorificSuffix = props.suffix;
  if (typeof props.title === "string") name.displayName = props.title;
  if (Object.keys(name).length > 0) payload.names = [name];

  if (typeof props.nickname === "string") {
    payload.nicknames = [{ value: props.nickname }];
  }

  if (Array.isArray(props.emails)) {
    payload.emailAddresses = props.emails
      .map((raw) => parseJsonObject(raw))
      .filter((o): o is Record<string, unknown> => o !== null)
      .map((o) => ({
        value: typeof o.value === "string" ? o.value : "",
        ...(typeof o.type === "string" ? { type: o.type } : {}),
      }));
  }
  if (Array.isArray(props.phones)) {
    payload.phoneNumbers = props.phones
      .map((raw) => parseJsonObject(raw))
      .filter((o): o is Record<string, unknown> => o !== null)
      .map((o) => ({
        value: typeof o.value === "string" ? o.value : "",
        ...(typeof o.type === "string" ? { type: o.type } : {}),
      }));
  }
  if (Array.isArray(props.addresses)) {
    payload.addresses = props.addresses
      .map((raw) => parseJsonObject(raw))
      .filter((o): o is Record<string, unknown> => o !== null);
  }

  const org: PersonOrganization = {};
  if (typeof props.organization === "string") org.name = props.organization;
  if (typeof props.job_title === "string") org.title = props.job_title;
  if (typeof props.department === "string") org.department = props.department;
  if (Object.keys(org).length > 0) payload.organizations = [org];

  if (typeof props.biography === "string") {
    payload.biographies = [
      { value: props.biography, contentType: "TEXT_PLAIN" },
    ];
  }

  if (typeof props.birthday === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(props.birthday);
    if (m !== null) {
      payload.birthdays = [
        {
          date: {
            year: Number(m[1]),
            month: Number(m[2]),
            day: Number(m[3]),
          },
        },
      ];
    } else {
      const m2 = /^--(\d{2})-(\d{2})$/.exec(props.birthday);
      if (m2 !== null) {
        payload.birthdays = [
          {
            date: { month: Number(m2[1]), day: Number(m2[2]) },
          },
        ];
      }
    }
  }

  return payload;
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function encodeResourceName(resourceName: string): string {
  if (resourceName.startsWith("people/")) {
    return `people/${encodeURIComponent(resourceName.slice("people/".length))}`;
  }
  return encodeURIComponent(resourceName);
}

function findExternalIdFor(
  cursor: ContactsCursor,
  marfa_id: string,
): string | null {
  for (const [ext, m] of Object.entries(cursor.mappings)) {
    if (m === marfa_id) return ext;
  }
  return null;
}

async function ackHandledIfMappedAsDelete(
  ctx: ConnectionContext,
  cursor: ContactsCursor,
  marfa_id: string,
): Promise<HandlerResult> {
  const externalId = findExternalIdFor(cursor, marfa_id);
  if (externalId === null) return { ok: true };
  const path = `${PEOPLE_API_BASE}/${encodeResourceName(externalId)}:deleteContact`;
  const resp = await ctx.marfa.proxyRequest("DELETE", path);
  if (!resp.ok && resp.status !== 404 && resp.status !== 410) {
    return reportOutboundFailure(ctx, "DELETE", externalId, resp);
  }
  Reflect.deleteProperty(cursor.mappings, externalId);
  await ctx.cursor.write(CURSOR_KEY, cursor);
  return { ok: true };
}

function contentHashForPerson(person: PersonResource): string {
  if (typeof person.etag === "string" && person.etag.length > 0) {
    return person.etag;
  }
  const parts: string[] = [
    person.resourceName,
    person.names?.[0]?.displayName ?? "",
    person.names?.[0]?.givenName ?? "",
    person.names?.[0]?.familyName ?? "",
    person.emailAddresses?.map((e) => e.value).join("|") ?? "",
    person.phoneNumbers?.map((p) => p.value).join("|") ?? "",
    person.organizations?.[0]?.name ?? "",
    person.biographies?.[0]?.value ?? "",
  ];
  return parts.join("|");
}

async function reportOutboundFailure(
  ctx: ConnectionContext,
  verb: string,
  externalId: string,
  resp: Response,
): Promise<HandlerResult> {
  const text = await resp.text().catch(() => "");
  const isServerError = resp.status >= 500;
  await ctx.activity.emit({
    severity: "action_required",
    summary: `google-contacts outbound: ${verb} ${externalId} returned ${String(resp.status)}`,
    detail: { status: resp.status, response_text: text.slice(0, 500) },
  });
  if (isServerError) {
    return {
      ok: false,
      retry: true,
      reason: `upstream_${String(resp.status)}`,
    };
  }
  return { ok: true };
}

async function reportFailure(
  ctx: ConnectionContext,
  summary: string,
  err: unknown,
  retry: boolean,
): Promise<HandlerResult> {
  await ctx.activity.emit({
    severity: "action_required",
    summary: `google-contacts: ${summary}`,
    detail: err === null ? undefined : { error: errorMessage(err) },
  });
  if (retry) return { ok: false, retry: true, reason: summary };
  return { ok: true };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

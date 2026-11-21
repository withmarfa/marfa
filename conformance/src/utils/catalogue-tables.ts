/**
 * The catalogues in the contract: the shipped types, the shipped edge types,
 * the fourteen permissions and the event types, each a table between two
 * markers in the chapter where it belongs. The rows come in as data so that
 * nothing here reads the server: `scripts/catalogue-tables.ts` passes them in
 * and the repository's own check compares what comes out to the chapters.
 */

/** The four catalogues, each named by the pair of markers around its table. */
export const CATALOGUES = [
  "types",
  "edge-types",
  "permissions",
  "event-types",
] as const;

export type Catalogue = (typeof CATALOGUES)[number];

/** The chapter each catalogue sits in, as a file name under `spec/`. */
export const CATALOGUE_CHAPTER: Readonly<Record<Catalogue, string>> = {
  types: "types.md",
  "edge-types": "edges.md",
  permissions: "keys-and-oauth.md",
  "event-types": "events.md",
};

export function tableStart(name: Catalogue): string {
  return `<!-- ${name}-table:start -->`;
}

export function tableEnd(name: Catalogue): string {
  return `<!-- ${name}-table:end -->`;
}

/** One shipped type, as the registry holds it. */
export interface TypeRow {
  id: string;
  family: "core" | "system";
  parent?: string;
  /** Every required property, the parent's included. */
  required: readonly string[];
  description?: string;
}

/** One shipped edge type, as its definition holds it. */
export interface EdgeTypeRow {
  id: string;
  label: string;
  reverseLabel: string;
  reverseName?: string;
  cardinality: string;
  cascadeOnDelete: string;
  fromTypes: readonly string[];
  toTypes: readonly string[];
}

/** One event type: its name and whether a webhook subscription may name it. */
export interface EventTypeRow {
  name: string;
  webhook: boolean;
}

/**
 * What each permission lets a credential do, in the words of the first
 * sentence of its row in `GLOSSARY.md`, which fixes the fourteen.
 */
const PERMISSION_TEXT: Readonly<Record<string, string>> = {
  "audit.read": "Reading the audit log.",
  "backups.manage":
    "Listing the backups, taking one now, adopting the backup folder and restoring a backup or an archive.",
  "blobs.manage":
    "Managing blob bytes and copies across the instance, without granting item content access.",
  "config.manage":
    "Reading and replacing the instance configuration at `/config`: the enforcement levers, the cleanup-job retention overrides and the stored settings, such as the addresses, the object store, the backup destination, the heartbeat and the PostHog settings. A secret setting can be set or removed but is never read back. A `PUT` keeps unnamed secrets, except `object_store_secret_access_key` when its bucket or endpoint changes. Changing `backup_path` or an `object_store_` setting other than the access key ID and the secret needs a recent sign-in, as `allow_private_addresses` does.",
  "connectors.manage":
    "Reading and administering connector registrations, their runs and their endpoints, deleting registrations and clearing a registration's retained state.",
  "grants.manage": "Listing, narrowing and revoking other apps' access.",
  "instance.maintain":
    "Running housekeeping, canceling bulk jobs, updating the server and confirming the server's clock.",
  "instance.read":
    "Reading detailed health, what needs the owner's attention, metrics, housekeeping status, blob storage diagnostics and bulk job status.",
  "items.purge":
    "Destroying a trashed item irrecoverably, through the single-item operation and the bulk one alike, and listing and emptying the trash.",
  "keys.manage":
    "Listing and revoking keys across the instance, changing their metadata, narrowing their access or lengthening their life, granting any source as a claim, and setting the name and mark of any source.",
  "keys.mint":
    "Minting keys within the caller's current access, and listing, changing and revoking keys within that access.",
  "sign_ins.manage":
    "Listing, renaming and ending the owner's sign-ins, listing, renaming and removing the owner's passkeys, getting the link that adds one and changing the owner's password.",
  "schema.write":
    "Removing or replacing type and edge type definitions, within the credential's type or edge write access, and adding, changing or removing a type's guidance when registering, replacing or restoring.",
  "webhooks.manage":
    "Reading, registering, changing and removing the outbound subscriptions that send an instance's events out, and redelivering what they sent.",
};

/** When each event is sent, written for this table, and the statements that hold each write to its event. */
const EVENT_TEXT: Readonly<
  Record<string, { when: string; statements: readonly string[] }>
> = {
  "item.created": {
    when: "A write creates an item.",
    statements: ["events/create-announced"],
  },
  "item.updated": {
    when: "A write changes an item.",
    statements: [
      "events/update-announced",
      "events/update-edges-only-announced",
      "housekeeping/enrichment-announced",
      "types/move-announced",
      "items/folder-announced",
      "views/announced",
    ],
  },
  "item.trashed": {
    when: "An item moves to the bin, or a cascade revokes a `system.*` item.",
    statements: [
      "items/delete-announced",
      "items/trash-cascade-announced",
      "events/owner-trash-announced",
      "housekeeping/feed-expiry-announced",
      "events/cascade-revoke-announced",
    ],
  },
  "item.restored": {
    when: "An item in the bin is restored.",
    statements: ["items/restore-announced", "events/owner-trash-announced"],
  },
  "item.purged": {
    when: "An item is destroyed.",
    statements: [
      "items/purge-announced",
      "events/owner-trash-announced",
      "events/sweep-purge-announced",
      "views/delete-announced",
    ],
  },
  "item.state_changed": {
    when: "A transition moves the item it names to another state, into and out of the bin included, or a key revokes a folder. A delete and a restore do not send it.",
    statements: [
      "items/transition-announced",
      "events/job-announced",
      "items/folder-announced",
      "events/delete-no-state-change",
      "events/restore-no-state-change",
    ],
  },
  "metadata.changed": {
    when: "A tag operation commits for an item, whether or not it changes the tags, or an extension namespace is written or deleted.",
    statements: ["items/tag-announced", "items/extension-announced"],
  },
  "rows.changed": {
    when: "A batch changes the rows of one table of an item, on a copy stream too.",
    statements: ["tables/rows-event", "tables/rows-event-copy-sent"],
  },
  "edge.created": {
    when: "An edge is created.",
    statements: [
      "edges/create-announced",
      "events/edge-bulk-announced",
      "events/edge-inline-announced",
      "versions/copy-edges-announced",
    ],
  },
  "edge.updated": {
    when: "An edge is written: its properties, or one of its ends moving to another item.",
    statements: [
      "edges/update-announced",
      "edges/move-announced",
      "events/edge-bulk-announced",
    ],
  },
  "attention.raised": {
    when: "A check of what needs the owner's attention first finds an entry, or the server first meets a fault.",
    statements: ["events/attention-raised", "events/attention-fault-at-once"],
  },
  "edge.deleted": {
    when: "An edge is deleted.",
    statements: [
      "edges/delete-announced",
      "events/edge-inline-announced",
      "items/purge-edges",
      "events/sweep-purge-edges",
    ],
  },
  stream_cursor: {
    when: "First, when the stream read the log as it opened: where the log stood then.",
    statements: [],
  },
  stream_live: {
    when: "Once the catch-up is over: everything up to its cursor has been sent or withheld, and what follows is live.",
    statements: [],
  },
  stream_incomplete: {
    when: "Last, when the stream can no longer deliver what it opened with.",
    statements: [],
  },
  catchup_too_old: {
    when: "Last, when the log no longer holds the events after the `Last-Event-ID` the client sent.",
    statements: [],
  },
  cursor_ahead: {
    when: "Last, when the `Last-Event-ID` the client sent is past the latest event in the log.",
    statements: [],
  },
  reach_changed: {
    when: "Last on a copy stream, when its reach changes.",
    statements: [],
  },
};

const CODE_POINT = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

function code(value: string): string {
  return `\`${value}\``;
}

function cell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/** Source prose with its em dashes turned into colons, which the contract's form test requires. */
function plain(text: string): string {
  return text.replace(/\s*—\s*/g, ": ");
}

function listOf(names: readonly string[]): string {
  return names.length === 0 ? "None" : names.map(code).join(", ");
}

/**
 * A Markdown table with its columns padded the way Prettier pads them, so
 * the format check accepts the chapter as written.
 */
export function renderTable(
  header: readonly string[],
  body: readonly (readonly string[])[],
): string {
  const rows = body.map((line) => line.map(cell));
  const widths = header.map((title, column) =>
    Math.max(
      3,
      title.length,
      ...rows.map((line) => (line[column] ?? "").length),
    ),
  );
  const line = (cells: readonly string[]) =>
    `| ${cells.map((text, column) => text.padEnd(widths[column] ?? 0)).join(" | ")} |`;
  return [
    line(header),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...rows.map(line),
  ].join("\n");
}

/** The shipped types, core before system and each by identifier. */
export function typesTable(rows: readonly TypeRow[]): string {
  const ordered = [...rows].sort(
    (a, b) => CODE_POINT(a.family, b.family) || CODE_POINT(a.id, b.id),
  );
  return renderTable(
    ["Type", "Family", "Parent", "Required properties", "Description"],
    ordered.map((row) => [
      code(row.id),
      row.family,
      row.parent === undefined ? "None" : code(row.parent),
      listOf(row.required),
      row.description === undefined ? "None" : plain(row.description),
    ]),
  );
}

/** How an edge type names the types it joins. */
function endpoints(constraints: readonly string[]): string {
  if (constraints.includes("*")) return "Any type";
  return constraints
    .map((entry) =>
      entry.startsWith("role:")
        ? `Any type with the role ${code(entry.slice("role:".length))}`
        : code(entry),
    )
    .join(", ");
}

/** The shipped edge types by identifier. */
export function edgeTypesTable(rows: readonly EdgeTypeRow[]): string {
  const ordered = [...rows].sort((a, b) => CODE_POINT(a.id, b.id));
  return renderTable(
    [
      "Edge type",
      "Label",
      "Reverse label",
      "Reverse name",
      "Cardinality",
      "On delete",
      "From item types",
      "To item types",
    ],
    ordered.map((row) => [
      code(row.id),
      row.label,
      row.reverseLabel,
      row.reverseName === undefined ? "None" : code(row.reverseName),
      row.cardinality,
      row.cascadeOnDelete,
      endpoints(row.fromTypes),
      endpoints(row.toTypes),
    ]),
  );
}

/** The permissions by name, each with what it lets a credential do. */
export function permissionsTable(names: readonly string[]): string {
  const missing = names.filter((name) => PERMISSION_TEXT[name] === undefined);
  const extra = Object.keys(PERMISSION_TEXT).filter(
    (name) => !names.includes(name),
  );
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `the permission list and the table's wording differ: no wording for ${JSON.stringify(missing)}, wording for no permission ${JSON.stringify(extra)}`,
    );
  }
  return renderTable(
    ["Permission", "What it lets a credential do"],
    [...names]
      .sort(CODE_POINT)
      .map((name) => [code(name), PERMISSION_TEXT[name] ?? ""]),
  );
}

/** The event types: the events first, then the frames only a stream sends. */
export function eventTypesTable(rows: readonly EventTypeRow[]): string {
  const names = rows.map((row) => row.name);
  const missing = names.filter((name) => EVENT_TEXT[name] === undefined);
  const extra = Object.keys(EVENT_TEXT).filter((name) => !names.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `the event list and the table's wording differ: no wording for ${JSON.stringify(missing)}, wording for no event ${JSON.stringify(extra)}`,
    );
  }
  // Source order is the stream's: the events as the webhook list names them,
  // then the frames that steer a stream.
  return renderTable(
    ["Event", "Sent to", "When it is sent", "Statements"],
    rows.map((row) => [
      code(row.name),
      row.webhook ? "Streams and webhooks" : "Streams",
      EVENT_TEXT[row.name]?.when ?? "",
      listOf(EVENT_TEXT[row.name]?.statements ?? []),
    ]),
  );
}

/** The chapter with the table between a catalogue's two markers replaced by `table`. */
export function withTable(
  chapter: string,
  name: Catalogue,
  table: string,
): string {
  const start = chapter.indexOf(tableStart(name));
  const end = chapter.indexOf(tableEnd(name));
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `the chapter needs ${tableStart(name)} and ${tableEnd(name)}, in that order, where the table goes`,
    );
  }
  return `${chapter.slice(0, start + tableStart(name).length)}\n\n${table}\n\n${chapter.slice(end)}`;
}

/**
 * The catalogues in the contract: the shipped types, the shipped edge types,
 * the twelve permissions and the event types, each a table between two
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
  reverseName?: string;
  cardinality: string;
  cascadeOnDelete: string;
  sourceTypes: readonly string[];
  targetTypes: readonly string[];
}

/** One event type: its name and whether a webhook subscription may name it. */
export interface EventTypeRow {
  name: string;
  webhook: boolean;
}

/**
 * What each permission lets a credential do, in the words of the first
 * sentence of its row in `GLOSSARY.md`, which fixes the twelve.
 */
const PERMISSION_TEXT: Readonly<Record<string, string>> = {
  "audit.read": "Reading the audit log.",
  "blobs.manage":
    "Managing blob bytes and locations across the instance, without granting item content access.",
  "config.manage":
    "Reading and replacing the instance configuration at `/config`: the enforcement levers and the cleanup-job retention overrides.",
  "connectors.manage":
    "Reading and administering connector registrations, their runs and their endpoints, deleting registrations and clearing a registration's retained state.",
  "grants.manage": "Listing and revoking other apps' access.",
  "instance.maintain":
    "Running housekeeping, resetting platform type definitions and cancelling bulk jobs.",
  "instance.read":
    "Reading detailed health, metrics, housekeeping status, platform drift, blob storage diagnostics and bulk job status.",
  "items.purge":
    "Destroying a trashed row irrecoverably, through the single-row operation and the bulk one alike.",
  "keys.manage":
    "Listing and revoking keys across the instance, and changing their metadata or narrowing access.",
  "keys.mint":
    "Minting keys within the caller's current access, and listing, changing and revoking keys within that access.",
  "schema.write":
    "Removing type and edge type definitions that already exist, and replacing them, only those the credential's type or edge map grants write on.",
  "webhooks.manage":
    "Reading, registering and removing the outbound subscriptions that send an instance's events out.",
};

/** When each event is sent, written for this table from the stream's own frame descriptions. */
const EVENT_TEXT: Readonly<Record<string, string>> = {
  "item.created": "An item is created.",
  "item.updated": "An item is updated.",
  "item.deleted": "An item is moved to the bin.",
  "item.restored": "An item in the bin is restored.",
  "item.purged": "A trashed item is destroyed.",
  "item.state_changed": "An item moves to another lifecycle state.",
  "metadata.changed": "An item's tags or extensions change.",
  "edge.created": "An edge is created.",
  "edge.updated": "An edge's properties change.",
  "edge.deleted": "An edge is deleted.",
  stream_cursor:
    "First on every stream: where the log stood when the stream opened.",
  stream_live:
    "Once the catch-up is over: everything up to its cursor has been sent, and what follows is live.",
  stream_incomplete:
    "Last, when the stream can no longer deliver what it opened with.",
  catchup_too_old:
    "Last, when the log no longer holds the events after the `Last-Event-ID` the client sent.",
  cursor_ahead:
    "Last, when the `Last-Event-ID` the client sent is past the latest event in the log.",
  read_view_changed: "Last on a copy stream, when its read view changes.",
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
      "Reverse name",
      "Cardinality",
      "On delete",
      "Source types",
      "Target types",
    ],
    ordered.map((row) => [
      code(row.id),
      row.reverseName === undefined ? "None" : code(row.reverseName),
      row.cardinality,
      row.cascadeOnDelete,
      endpoints(row.sourceTypes),
      endpoints(row.targetTypes),
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
    ["Event", "Sent to", "When it is sent"],
    rows.map((row) => [
      code(row.name),
      row.webhook ? "Streams and webhooks" : "Streams",
      EVENT_TEXT[row.name] ?? "",
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

/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * The Activity page of the owner console: the audit log, newest first, as the
 * log holds it. A row says what happened, to what, by which key and from where.
 */
import {
  PAGE_SIZE,
  type PageSize,
  type Pagination,
} from "../pages/navigation.js";
import {
  ConsolePage,
  EmptyState,
  ListToolbar,
  LocalDate,
  PageHeader,
  Pager,
  Row,
  RowGroup,
  SearchField,
  Select,
} from "../pages/parts/index.js";
import { renderDocument } from "../pages/render.js";
import type { AuditKind } from "../storage/audit-kinds.js";
import type { AuditEntry } from "../storage/interface.js";

export const ACTIVITY_HREF = "/auth/owner/activity";

export const KIND_LABELS: Record<AuditKind, string> = {
  access: "Access",
  data: "Your data",
  settings: "Settings",
  housekeeping: "Housekeeping",
};

/** How far back the time select reaches, by the value the address carries. */
export const WHENS = {
  day: { label: "Past 24 hours", ms: 24 * 3_600_000 },
  week: { label: "Past 7 days", ms: 7 * 24 * 3_600_000 },
  month: { label: "Past 30 days", ms: 30 * 24 * 3_600_000 },
  quarter: { label: "Past 90 days", ms: 90 * 24 * 3_600_000 },
} as const;

export type When = keyof typeof WHENS;

export interface ActivityView {
  kind?: AuditKind;
  when?: When;
  query?: string;
  size?: PageSize;
  page?: number;
}

/** The address of a view of the log: only what differs from the first view is in it. */
export function activityHref(view: ActivityView): string {
  const query = new URLSearchParams();
  if (view.kind) query.set("kind", view.kind);
  if (view.when) query.set("when", view.when);
  if (view.query) query.set("q", view.query);
  if (view.size !== undefined && view.size !== PAGE_SIZE)
    query.set("size", String(view.size));
  if (view.page !== undefined && view.page > 1)
    query.set("page", String(view.page));
  const text = query.toString();
  return text === "" ? ACTIVITY_HREF : `${ACTIVITY_HREF}?${text}`;
}

export interface ActivityRow {
  entry: AuditEntry;
  /** How long ago, in words. */
  ago: string;
}

export interface ActivityParams {
  nonce: string;
  instanceName: string;
  view: ActivityView;
  rows: readonly ActivityRow[];
  pagination: Pagination;
  /** Where General is, once it is built, for the line about how long activity is kept. */
  generalHref: string | undefined;
  retentionDays: number | undefined;
}

/** What a row says under its title: the resource, the key and the address, when it has them. */
function EntryLine(props: { entry: AuditEntry }) {
  const { entry } = props;
  const on =
    entry.resource_id === null
      ? entry.resource_type
      : `${entry.resource_type} ${entry.resource_id}`;
  return (
    <>
      On {on}. By {entry.actor?.name ?? "an unknown sign-in"}
      {entry.actor &&
        ["key", "app", "browser"].includes(entry.actor.kind) &&
        ` (${entry.actor.kind})`}
      .{entry.client_ip !== null && ` From ${entry.client_ip}.`}{" "}
      <LocalDate at={new Date(entry.created_at)} />
    </>
  );
}

const KIND_OPTIONS = [
  { value: "", label: "All activity" },
  ...(Object.keys(KIND_LABELS) as AuditKind[]).map((value) => ({
    value,
    label: KIND_LABELS[value],
  })),
];

const WHEN_OPTIONS = [
  { value: "", label: "Any time" },
  ...(Object.keys(WHENS) as When[]).map((value) => ({
    value,
    label: WHENS[value].label,
  })),
];

function ActivityLede(props: ActivityParams) {
  const { retentionDays, generalHref } = props;
  if (retentionDays === undefined) return <>Every change, and what made it.</>;
  const kept =
    retentionDays === 0
      ? "Activity is kept forever."
      : `Activity is kept for ${String(retentionDays)} ${retentionDays === 1 ? "day" : "days"}.`;
  return (
    <>
      Every change, and what made it, newest first. {kept}
      {generalHref !== undefined && (
        <>
          {" "}
          <a href={generalHref}>Change in General</a>.
        </>
      )}
    </>
  );
}

export function ActivityPage(props: ActivityParams) {
  const { view, pagination } = props;
  const filtered =
    view.kind !== undefined ||
    view.when !== undefined ||
    (view.query ?? "") !== "";
  return (
    <ConsolePage
      title="Activity"
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[{ label: "Activity" }]}
      pageId="activity"
    >
      <div class="stack-24">
        <PageHeader title="Activity" lede={<ActivityLede {...props} />} />
        <ListToolbar
          action={ACTIVITY_HREF}
          label="Filter activity"
          filters={
            <>
              <Select
                name="kind"
                label="Kind of activity"
                value={view.kind ?? ""}
                options={KIND_OPTIONS}
                auto
                autosubmit
              />
              <Select
                name="when"
                label="How far back"
                value={view.when ?? ""}
                options={WHEN_OPTIONS}
                auto
                autosubmit
              />
            </>
          }
          search={
            <>
              {pagination.size !== PAGE_SIZE && (
                <input
                  type="hidden"
                  name="size"
                  value={String(pagination.size)}
                />
              )}
              <SearchField
                value={view.query ?? ""}
                placeholder="Search activity"
              />
            </>
          }
        />
        <RowGroup>
          {props.rows.length === 0 ? (
            <EmptyState
              title={filtered ? "No activity matches" : "No activity yet"}
              description={
                filtered
                  ? "Try another kind, a longer time or fewer words."
                  : "Changes, sign-ins and exports appear here."
              }
            />
          ) : (
            props.rows.map(({ entry, ago }) => (
              <Row
                title={entry.action}
                description={<EntryLine entry={entry} />}
                value={ago}
              />
            ))
          )}
        </RowGroup>
        <Pager
          pagination={pagination}
          href={(page) =>
            activityHref({ ...view, size: pagination.size, page })
          }
          noun="activity"
          open
          carry={{
            ...(view.kind ? { kind: view.kind } : {}),
            ...(view.when ? { when: view.when } : {}),
            ...(view.query ? { q: view.query } : {}),
          }}
        />
      </div>
    </ConsolePage>
  );
}

export const renderActivityPage = (params: ActivityParams): string =>
  renderDocument(<ActivityPage {...params} />);

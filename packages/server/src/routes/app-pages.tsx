/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * The connected apps pages of the owner console: the list of the apps the
 * owner has approved, and one app's page with what it can reach, the keys it
 * made, and Disconnect.
 *
 * The pages are drawn here from what `app-routes.ts` read. Disconnecting is
 * done by the browser module `client/sign-ins.ts` through
 * `DELETE /owner/sign-ins/{id}`, the door every other caller uses. The words
 * a script needs are written into the markup here, so the script only chooses
 * which to show.
 */
import type { AppKind } from "../auth/connected-apps.js";
import {
  PAGE_SIZE,
  type PageSize,
  type Pagination,
} from "../pages/navigation.js";
import {
  Button,
  ClosingAction,
  ConsolePage,
  Dialog,
  EmptyState,
  ListToolbar,
  Notice,
  PageHeader,
  Pager,
  Row,
  RowGroup,
  SearchField,
  Section,
  Select,
  Switch,
} from "../pages/parts/index.js";
import type { RegistryItem } from "../pages/registry.js";
import { renderDocument } from "../pages/render.js";
import { AccessView, type AccessViewProps } from "./access-view.js";
import { KeyRows, type KeyListRow } from "./key-pages.js";

export const APPS_HREF = "/auth/owner/apps";

/** The address of one app's page. */
export const appHref = (id: string): string =>
  `${APPS_HREF}/${encodeURIComponent(id)}`;

const APPS_TRAIL = { label: "Connected apps", href: APPS_HREF } as const;

/** What the Kind select offers. */
export type KindFilter = AppKind | "all";

export const KIND_OPTIONS: readonly { value: KindFilter; label: string }[] = [
  { value: "all", label: "All apps" },
  { value: "app", label: "Apps" },
  { value: "web", label: "Web pages" },
  { value: "cli", label: "Command line" },
];

interface PageBase {
  nonce: string;
  instanceName: string;
}

/** The flash a page shows once, after the page before it changed something. */
function Flash() {
  return (
    <div data-notice="flash" hidden>
      <Notice>
        <span data-notice-text></span>
      </Notice>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export interface AppListRow {
  id: string;
  name: string;
  description: string;
  value: string;
}

export interface AppListParams extends PageBase {
  kind: KindFilter;
  /** What the person searched for, already trimmed. */
  query: string;
  /** How many apps are connected, whatever is chosen or searched. */
  total: number;
  /** The rows of the page shown. */
  rows: readonly AppListRow[];
  pagination: Pagination;
}

/** The address of a view of the list: only what differs from the first view is in it. */
export function appListHref(view: {
  kind?: KindFilter;
  query?: string;
  size?: PageSize;
  page?: number;
}): string {
  const query = new URLSearchParams();
  if (view.kind !== undefined && view.kind !== "all")
    query.set("kind", view.kind);
  if (view.query) query.set("q", view.query);
  if (view.size !== undefined && view.size !== PAGE_SIZE)
    query.set("size", String(view.size));
  if (view.page !== undefined && view.page > 1)
    query.set("page", String(view.page));
  const text = query.toString();
  return text === "" ? APPS_HREF : `${APPS_HREF}?${text}`;
}

function emptyList(params: AppListParams) {
  if (params.total === 0)
    return (
      <EmptyState
        title="No connected apps"
        description="When an app asks for access and you approve it, it shows here. So does the marfa command line once you sign in with it."
      />
    );
  if (params.query !== "")
    return (
      <EmptyState
        title="No apps match"
        description="Try another word from the name."
      />
    );
  return (
    <EmptyState
      title="None of this kind"
      description="Choose All apps to see the rest."
    />
  );
}

export function AppListPage(props: AppListParams) {
  const { kind, query, pagination } = props;
  return (
    <ConsolePage
      title="Connected apps"
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[{ label: "Connected apps" }]}
      pageId="apps"
    >
      <div class="stack-24">
        <PageHeader
          title="Connected apps"
          lede="Apps you've approved, and what each can access. An app asks the first time it needs access."
        />
        <Flash />
        {props.total > 0 && (
          <ListToolbar
            action={APPS_HREF}
            label="Search apps"
            filters={
              <Select
                name="kind"
                label="Kind of app"
                value={kind}
                options={KIND_OPTIONS}
                auto
                autosubmit
              />
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
                <SearchField value={query} placeholder="Search apps" />
              </>
            }
          />
        )}
        <RowGroup oneLine>
          {props.rows.length === 0 ? (
            emptyList(props)
          ) : (
            <>
              {props.rows.map((row) => (
                <Row
                  title={row.name}
                  description={row.description}
                  value={row.value}
                  href={appHref(row.id)}
                />
              ))}
            </>
          )}
        </RowGroup>
        <Pager
          pagination={pagination}
          href={(page) =>
            appListHref({ kind, query, size: pagination.size, page })
          }
          noun="apps"
          carry={{
            ...(kind === "all" ? {} : { kind }),
            ...(query === "" ? {} : { q: query }),
          }}
        />
      </div>
    </ConsolePage>
  );
}

export const renderAppListPage = (params: AppListParams): string =>
  renderDocument(<AppListPage {...params} />);

// ---------------------------------------------------------------------------
// An app
// ---------------------------------------------------------------------------

/** One line of the Details section. */
export interface AppDetail {
  title: string;
  value: string;
}

export interface AppPageParams extends PageBase {
  id: string;
  name: string;
  details: readonly AppDetail[];
  /** What the app holds, read-only. */
  access: AccessViewProps;
  /** The keys the app made, in the rows the API keys list uses. */
  keys: readonly KeyListRow[];
  /** Apps to list in the picker beside the page. */
  siblings: readonly RegistryItem[];
}

const keyCount = (n: number): string =>
  `${String(n)} ${n === 1 ? "key" : "keys"}`;

export function AppPage(props: AppPageParams) {
  const made = props.keys.length;
  return (
    <ConsolePage
      title={props.name}
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[APPS_TRAIL, { label: props.name }]}
      pageId="apps"
      items={{ apps: props.siblings }}
      currentItemHref={appHref(props.id)}
    >
      <div class="stack-24">
        <PageHeader
          title={props.name}
          lede="You can disconnect it at any time. It asks again the next time it needs access."
        />
        <Flash />
        <Section id="details" title="Details">
          <RowGroup>
            {props.details.map((detail) => (
              <Row title={detail.title} value={detail.value} valueAuto />
            ))}
          </RowGroup>
        </Section>
        <Section
          id="access"
          title="Access"
          description="What it can read and change. To change it, disconnect it and approve it again."
        >
          <AccessView {...props.access} />
        </Section>
        <Section
          id="keys"
          title="Keys it made"
          description="Each holds no more than the app does."
        >
          <RowGroup oneLine>
            {made === 0 ? (
              <EmptyState
                title="No keys"
                description="Keys this app makes show here."
              />
            ) : (
              <KeyRows rows={props.keys} />
            )}
          </RowGroup>
        </Section>
      </div>
      <ClosingAction>
        <Row
          title={`Disconnect ${props.name}`}
          description="It loses access at once. It asks again the next time it needs it."
          buttons={
            <Button kind="danger-quiet" opens="app-disconnect-dialog">
              Disconnect
            </Button>
          }
        />
      </ClosingAction>
      <Dialog
        id="app-disconnect-dialog"
        title={`Disconnect ${props.name}?`}
        description="It loses access at once, and asks again the next time it needs it."
        data={{
          "app-id": props.id,
          "app-name": props.name,
          "confirm-why": "Disconnecting an app needs a recent sign-in.",
        }}
        actions={
          <>
            <Button kind="outline" closes>
              Cancel
            </Button>
            <Button
              kind="danger"
              loadingLabel="Disconnecting..."
              hook="app-disconnect"
            >
              Disconnect
            </Button>
          </>
        }
      >
        {made > 0 && (
          <RowGroup>
            <Row
              title="Also revoke the keys it made"
              description={`${keyCount(made)} would stop working`}
              for="app-revoke-keys"
              control={
                <Switch
                  id="app-revoke-keys"
                  label="Also revoke the keys it made"
                  checked
                />
              }
            />
          </RowGroup>
        )}
        <div data-notice="disconnect-problem" hidden>
          <Notice tone="error">
            <span data-notice-text></span>
          </Notice>
        </div>
      </Dialog>
    </ConsolePage>
  );
}

export const renderAppPage = (params: AppPageParams): string =>
  renderDocument(<AppPage {...params} />);

/** What the person meets at the address of an app that is not connected. */
export function MissingAppPage(props: PageBase) {
  return (
    <ConsolePage
      title="Connected apps"
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[APPS_TRAIL, { label: "Not found" }]}
      pageId="apps"
    >
      <div class="stack-24">
        <PageHeader title="This app isn't connected" />
        <RowGroup>
          <EmptyState
            title="It may have been disconnected"
            description="Apps that are disconnected are not listed. An app asks again the next time it needs access."
            action={
              <Button kind="outline" href={APPS_HREF}>
                Go to Connected apps
              </Button>
            }
          />
        </RowGroup>
      </div>
    </ConsolePage>
  );
}

export const renderMissingAppPage = (params: PageBase): string =>
  renderDocument(<MissingAppPage {...params} />);

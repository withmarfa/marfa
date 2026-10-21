/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * The connectors pages of the owner console: the list and a connector's own
 * page. They are drawn here from what `connector-routes.ts` read. Clearing a
 * connector's saved state and removing it are done by the browser module
 * `client/connectors.ts` through `DELETE /connectors/{id}/state` and
 * `DELETE /connectors/{id}`, the doors every other caller uses.
 */
import type { Pagination } from "../pages/navigation.js";
import {
  Button,
  ConsolePage,
  DangerRow,
  Dialog,
  EmptyState,
  Notice,
  PageHeader,
  Pager,
  Row,
  RowGroup,
  Section,
} from "../pages/parts/index.js";
import type { RegistryItem } from "../pages/registry.js";
import { renderDocument } from "../pages/render.js";

export const CONNECTORS_HREF = "/auth/owner/connectors";

/** The address of one connector's page. */
export const connectorHref = (id: string): string =>
  `${CONNECTORS_HREF}/${encodeURIComponent(id)}`;

const TRAIL = { label: "Connectors", href: CONNECTORS_HREF } as const;

interface PageBase {
  nonce: string;
  instanceName: string;
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export interface ConnectorListRow {
  id: string;
  name: string;
  description: string;
  /** The state in a word: "Running", "Failing". */
  value: string;
  tone?: "warn" | "danger";
}

export interface ConnectorListParams extends PageBase {
  rows: readonly ConnectorListRow[];
  pagination: Pagination;
}

export function ConnectorListPage(props: ConnectorListParams) {
  return (
    <ConsolePage
      title="Connectors"
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[{ label: "Connectors" }]}
      pageId="connectors"
    >
      <div class="stack-24">
        <PageHeader
          title="Connectors"
          lede="Programs outside Marfa that bring in data from other services. Each signs in with its own key, and you start, stop or schedule it where it runs."
        />
        <div data-notice="flash" hidden>
          <Notice>
            <span data-notice-text></span>
          </Notice>
        </div>
        <RowGroup oneLine>
          {props.rows.length === 0 ? (
            <EmptyState
              title="No connectors"
              description="A connector brings data into Marfa from another service, such as your mail or calendar."
            />
          ) : (
            props.rows.map((row) => (
              <Row
                title={row.name}
                description={row.description}
                value={row.value}
                valueTone={row.tone}
                href={connectorHref(row.id)}
              />
            ))
          )}
        </RowGroup>
        <Pager
          pagination={props.pagination}
          href={(page) =>
            page > 1
              ? `${CONNECTORS_HREF}?page=${String(page)}`
              : CONNECTORS_HREF
          }
          noun="connectors"
        />
      </div>
    </ConsolePage>
  );
}

export const renderConnectorListPage = (params: ConnectorListParams): string =>
  renderDocument(<ConnectorListPage {...params} />);

// ---------------------------------------------------------------------------
// A connector
// ---------------------------------------------------------------------------

/** What the connector's page says first, when something needs a look. */
export interface ConnectorNotice {
  tone: "info" | "error";
  title: string;
  description?: string;
}

/** One line of the Details section; a link when `href` is set. */
export interface ConnectorDetail {
  title: string;
  value: string;
  href?: string;
}

export interface ConnectorRunRow {
  /** When it ran, in words. */
  title: string;
  /** "Succeeded" or "Failed". */
  value: string;
  failed: boolean;
  description?: string;
}

export interface ConnectorPageParams extends PageBase {
  id: string;
  name: string;
  description: string | null;
  notice?: ConnectorNotice;
  details: readonly ConnectorDetail[];
  /** What the connector reported is wrong, by name. */
  problems: readonly { title: string; description: string }[];
  runs: readonly ConnectorRunRow[];
  siblings: readonly RegistryItem[];
}

export function ConnectorPage(props: ConnectorPageParams) {
  return (
    <ConsolePage
      title={props.name}
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[TRAIL, { label: props.name }]}
      pageId="connectors"
      items={{ connectors: props.siblings }}
      currentItemHref={connectorHref(props.id)}
    >
      <div class="stack-24">
        <PageHeader title={props.name} lede={props.description ?? undefined} />
        <div data-notice="flash" hidden>
          <Notice>
            <span data-notice-text></span>
          </Notice>
        </div>
        {props.notice !== undefined && (
          <Notice tone={props.notice.tone} title={props.notice.title}>
            {props.notice.description}
          </Notice>
        )}
        <Section id="details" title="Details">
          <RowGroup>
            {props.details.map((detail) =>
              detail.href === undefined ? (
                <Row title={detail.title} value={detail.value} valueAuto />
              ) : (
                <Row
                  title={detail.title}
                  value={detail.value}
                  valueAuto
                  href={detail.href}
                />
              ),
            )}
          </RowGroup>
        </Section>
        {props.problems.length > 0 && (
          <Section
            id="problems"
            title="Problems"
            description="What the connector says is wrong."
          >
            <RowGroup>
              {props.problems.map((problem) => (
                <Row
                  title={problem.title}
                  description={problem.description}
                  dot="warn"
                />
              ))}
            </RowGroup>
          </Section>
        )}
        <Section
          id="runs"
          title="Runs"
          description="The runs it has reported, newest first."
        >
          <RowGroup>
            {props.runs.length === 0 ? (
              <EmptyState title="No runs yet" />
            ) : (
              props.runs.map((run) => (
                <Row
                  title={run.title}
                  description={run.description}
                  value={run.value}
                  valueTone={run.failed ? "danger" : undefined}
                />
              ))
            )}
          </RowGroup>
        </Section>
      </div>
      <DangerRow
        title="Clear saved state"
        description="It starts again from the beginning on its next run."
        action={
          <Button kind="danger-quiet" opens="connector-clear-dialog">
            Clear
          </Button>
        }
      />
      <DangerRow
        title="Remove connector"
        description="Removes it, its runs, its webhook endpoints and their stored deliveries from Marfa, not the program itself. Can't be undone."
        action={
          <Button kind="danger-quiet" opens="connector-remove-dialog">
            Remove
          </Button>
        }
      />
      <ConnectorDialog
        id="connector-clear-dialog"
        connector={props}
        title={`Clear saved state for ${props.name}?`}
        description="It forgets what it has already brought in and starts again from the beginning on its next run."
        action="Clear"
        loading="Clearing..."
        hook="connector-clear"
      />
      <ConnectorDialog
        id="connector-remove-dialog"
        connector={props}
        title={`Remove the ${props.name} connector?`}
        description="This also deletes its webhook endpoints and their stored deliveries. The program keeps running until you stop it where it runs, and its key works until you revoke it. This can't be undone."
        action="Remove"
        loading="Removing..."
        hook="connector-remove"
      />
    </ConsolePage>
  );
}

function ConnectorDialog(props: {
  id: string;
  connector: { id: string; name: string };
  title: string;
  description: string;
  action: string;
  loading: string;
  hook: string;
}) {
  return (
    <Dialog
      id={props.id}
      title={props.title}
      description={props.description}
      data={{
        "connector-id": props.connector.id,
        "connector-name": props.connector.name,
      }}
      actions={
        <>
          <Button kind="outline" closes>
            Cancel
          </Button>
          <Button kind="danger" loadingLabel={props.loading} hook={props.hook}>
            {props.action}
          </Button>
        </>
      }
    >
      <div data-notice={`${props.hook}-problem`} hidden>
        <Notice tone="error">
          <span data-notice-text></span>
        </Notice>
      </div>
    </Dialog>
  );
}

export const renderConnectorPage = (params: ConnectorPageParams): string =>
  renderDocument(<ConnectorPage {...params} />);

/** What the person meets at the address of a connector that is not there. */
export function MissingConnectorPage(props: PageBase) {
  return (
    <ConsolePage
      title="Connectors"
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[TRAIL, { label: "Not found" }]}
      pageId="connectors"
    >
      <div class="stack-24">
        <PageHeader title="This connector isn't here" />
        <RowGroup>
          <EmptyState
            title="It may have been removed"
            description="Connectors that are gone are not listed."
            action={
              <Button kind="outline" href={CONNECTORS_HREF}>
                Go to Connectors
              </Button>
            }
          />
        </RowGroup>
      </div>
    </ConsolePage>
  );
}

export const renderMissingConnectorPage = (params: PageBase): string =>
  renderDocument(<MissingConnectorPage {...params} />);

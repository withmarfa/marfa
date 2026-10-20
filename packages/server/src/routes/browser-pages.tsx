/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * The Browsers page of the owner console: where the owner is signed in to
 * these pages, with Sign out for each browser but this one and Sign out
 * others for all of them at once.
 *
 * Signing out is done by the browser module `client/sign-ins.ts`: one browser
 * through `DELETE /owner/sign-ins/{id}`, the others through
 * `POST /auth/revoke-other-sessions`. This browser's own sign-in is never
 * offered for sign-out here; the Sign out in the account menu ends it.
 */
import {
  Button,
  ConsolePage,
  DangerRow,
  Dialog,
  EmptyState,
  Notice,
  PageHeader,
  Row,
  RowGroup,
} from "../pages/parts/index.js";
import { renderDocument } from "../pages/render.js";

export const BROWSERS_HREF = "/auth/owner/browsers";

export interface BrowserRow {
  id: string;
  name: string;
  /** Whether this is the browser the page is open in. */
  current: boolean;
  description: string;
  value: string;
}

export interface BrowsersParams {
  nonce: string;
  instanceName: string;
  rows: readonly BrowserRow[];
}

/** The one place the words of a refused or failed sign-out are written. */
function ProblemNotice() {
  return (
    <div data-notice="problem" hidden>
      <Notice tone="error">
        <span data-notice-text></span>
      </Notice>
    </div>
  );
}

export function BrowsersPage(props: BrowsersParams) {
  const others = props.rows.filter((row) => !row.current).length;
  return (
    <ConsolePage
      title="Browsers"
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[{ label: "Browsers" }]}
      pageId="browsers"
    >
      <div
        class="stack-24"
        data-sign-out-why="Signing out a browser needs a recent sign-in."
      >
        <PageHeader
          title="Browsers"
          lede="Where you're signed in to these pages. A browser is signed out after 7 days unused."
        />
        <div data-notice="flash" hidden>
          <Notice>
            <span data-notice-text></span>
          </Notice>
        </div>
        <ProblemNotice />
        <RowGroup>
          {props.rows.length === 0 ? (
            <EmptyState
              title="No browsers are signed in"
              description="This page is open without a browser sign-in."
            />
          ) : (
            <>
              {props.rows.map((row) => (
                <Row
                  title={row.name}
                  badge={row.current ? "This browser" : undefined}
                  description={row.description}
                  value={row.value}
                  buttons={
                    row.current ? undefined : (
                      <Button
                        kind="quiet"
                        loadingLabel="Signing out..."
                        hook="browser-sign-out"
                        label={`Sign out ${row.name}`}
                        data={{
                          "sign-in-id": row.id,
                          "sign-in-name": row.name,
                        }}
                      >
                        Sign out
                      </Button>
                    )
                  }
                />
              ))}
            </>
          )}
        </RowGroup>
      </div>
      {others > 0 && (
        <DangerRow
          title="Sign out of all other browsers"
          description={`Ends ${others === 1 ? "1 sign-in" : `${String(others)} sign-ins`}. You stay signed in here.`}
          action={
            <Button kind="danger-quiet" opens="browsers-others-dialog">
              Sign out others
            </Button>
          }
        />
      )}
      {others > 0 && (
        <Dialog
          id="browsers-others-dialog"
          title="Sign out of all other browsers?"
          description="Each one has to sign in again. You stay signed in here."
          data={{
            "confirm-why": "Signing out other browsers needs a recent sign-in.",
          }}
          actions={
            <>
              <Button kind="outline" closes>
                Cancel
              </Button>
              <Button
                kind="danger"
                loadingLabel="Signing out..."
                hook="browsers-others"
              >
                Sign out others
              </Button>
            </>
          }
        >
          <div data-notice="others-problem" hidden>
            <Notice tone="error">
              <span data-notice-text></span>
            </Notice>
          </div>
        </Dialog>
      )}
    </ConsolePage>
  );
}

export const renderBrowsersPage = (params: BrowsersParams): string =>
  renderDocument(<BrowsersPage {...params} />);

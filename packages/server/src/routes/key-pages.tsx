/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * The API keys pages of the owner console: the list, Create key, the one-time
 * copy of a new key's secret, and a key's own page.
 *
 * The pages are drawn here from what `key-routes.ts` read. Making, changing
 * and revoking a key are done by the browser module `client/keys.ts` through
 * `POST /keys`, `PATCH /keys/{id}` and `DELETE /keys/{id}`, the doors every
 * other caller uses. The words a script needs (the reasons a key cannot be
 * made yet, what a refusal says) are written into the markup here, so the
 * script only chooses which to show.
 */
import {
  PAGE_SIZE,
  type PageSize,
  type Pagination,
} from "../pages/navigation.js";
import {
  Button,
  ConsolePage,
  DangerRow,
  Dialog,
  EmptyState,
  FormFoot,
  ListToolbar,
  Notice,
  PageHeader,
  Pager,
  Row,
  RowGroup,
  RowInput,
  SaveBar,
  SearchField,
  Section,
  Select,
  Tabs,
} from "../pages/parts/index.js";
import type { RegistryItem } from "../pages/registry.js";
import { ALL_EXTENSIONS } from "../pages/access-summary.js";
import { END_CHOICES, type EndChoice } from "../pages/key-body.js";
import { renderDocument } from "../pages/render.js";
import { AccessChoices, offersChoice } from "./access-choices.js";
import { LEVEL_LABELS, type AccessModel } from "./access-model.js";

export const KEYS_HREF = "/auth/owner/keys";
export const NEW_KEY_HREF = `${KEYS_HREF}/new`;

/** The address of one key's page. */
export const keyHref = (id: string): string =>
  `${KEYS_HREF}/${encodeURIComponent(id)}`;

/** The address of the page that shows a new key's secret once. */
export const copyHref = (id: string): string => `${keyHref(id)}/copy`;

const KEYS_TRAIL = { label: "API keys", href: KEYS_HREF } as const;

/** What the Ends select offers a key being made, and the choices a saved key can be given. */
const END_LABELS: Record<(typeof END_CHOICES)[number], string> = {
  never: "Never",
  "30": "30 days",
  "90": "90 days",
  "365": "1 year",
};

const END_OPTIONS = END_CHOICES.map((value) => ({
  value,
  label: END_LABELS[value],
}));

interface PageBase {
  nonce: string;
  instanceName: string;
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export interface KeyListRow {
  id: string;
  label: string;
  description: string;
  /** Amber, for a key that ends within the week. */
  endsSoon: boolean;
  value: string;
}

export type KeyTab = "yours" | "apps";

export interface KeyListParams extends PageBase {
  tab: KeyTab;
  /** What the person searched for, already trimmed. */
  query: string;
  /** How many keys each tab holds, whatever is searched. */
  counts: { yours: number; apps: number };
  /** The rows of the page shown. */
  rows: readonly KeyListRow[];
  pagination: Pagination;
}

/** The address of a view of the list: only what differs from the first view is in it. */
export function listHref(view: {
  tab?: KeyTab;
  query?: string;
  size?: PageSize;
  page?: number;
}): string {
  const query = new URLSearchParams();
  if (view.tab === "apps") query.set("tab", "apps");
  if (view.query) query.set("q", view.query);
  if (view.size !== undefined && view.size !== PAGE_SIZE)
    query.set("size", String(view.size));
  if (view.page !== undefined && view.page > 1)
    query.set("page", String(view.page));
  const text = query.toString();
  return text === "" ? KEYS_HREF : `${KEYS_HREF}?${text}`;
}

function emptyList(tab: KeyTab, query: string) {
  if (query !== "")
    return (
      <EmptyState
        title="No keys match"
        description="Try another word from the name."
      />
    );
  if (tab === "apps")
    return (
      <EmptyState
        title="No keys made by apps"
        description="An app you allow to make keys lists them here."
      />
    );
  return (
    <EmptyState
      title="No keys yet"
      description="Create a key for a script or tool. It holds only what you turn on."
    />
  );
}

export function KeyListPage(props: KeyListParams) {
  const { tab, query, counts, pagination } = props;
  const hasKeys = counts.yours + counts.apps > 0;
  return (
    <ConsolePage
      title="API keys"
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[{ label: "API keys" }]}
      pageId="keys"
    >
      <div class="stack-24">
        <PageHeader
          title="API keys"
          lede="Keys let scripts and tools use Marfa. Each holds only what you give it."
          action={
            <Button kind="primary" href={NEW_KEY_HREF}>
              Create key
            </Button>
          }
        />
        <div data-notice="flash" hidden>
          <Notice>
            <span data-notice-text></span>
          </Notice>
        </div>
        {hasKeys && (
          <ListToolbar
            action={KEYS_HREF}
            label="Search keys"
            filters={
              <Tabs
                label="Keys"
                tabs={[
                  {
                    label: "Your keys",
                    href: listHref({ tab: "yours" }),
                    current: tab === "yours",
                    count: counts.yours,
                  },
                  {
                    label: "Made by apps",
                    href: listHref({ tab: "apps" }),
                    current: tab === "apps",
                    count: counts.apps,
                  },
                ]}
              />
            }
            search={
              <>
                {tab === "apps" && (
                  <input type="hidden" name="tab" value="apps" />
                )}
                {pagination.size !== PAGE_SIZE && (
                  <input
                    type="hidden"
                    name="size"
                    value={String(pagination.size)}
                  />
                )}
                <SearchField value={query} placeholder="Search keys" />
              </>
            }
          />
        )}
        <RowGroup oneLine>
          {props.rows.length === 0
            ? emptyList(tab, query)
            : props.rows.map((row) => (
                <Row
                  title={row.label}
                  description={row.description}
                  descriptionTone={row.endsSoon ? "warn" : undefined}
                  value={row.value}
                  href={keyHref(row.id)}
                />
              ))}
        </RowGroup>
        <Pager
          pagination={pagination}
          href={(page) => listHref({ tab, query, size: pagination.size, page })}
          noun="keys"
          carry={{
            ...(tab === "apps" ? { tab } : {}),
            ...(query === "" ? {} : { q: query }),
          }}
        />
      </div>
    </ConsolePage>
  );
}

export const renderKeyListPage = (params: KeyListParams): string =>
  renderDocument(<KeyListPage {...params} />);

// ---------------------------------------------------------------------------
// Create key
// ---------------------------------------------------------------------------

const EXTENSION_OPTIONS = (["none", "read", "write"] as const).map((level) => ({
  value: level,
  label: LEVEL_LABELS[level],
}));

export interface CreateKeyParams extends PageBase {
  /** Every control starting off, from `buildAccess` with `start: "off"`. */
  access: AccessModel;
}

/** The reasons the Create key button gives while the form is not ready. */
const CREATE_REASONS = {
  name: "Give the key a name",
  access: "Turn on at least one thing it can do",
} as const;

/** The one place the words of a refused or failed change are written. */
function ProblemNotice() {
  return (
    <div data-notice="problem" hidden>
      <Notice tone="error">
        <span data-notice-text></span>
      </Notice>
    </div>
  );
}

/** The key's secret, shown in place of the form once it has been made. */
function CopyView() {
  return (
    <section data-key-copy hidden class="stack-24">
      <PageHeader
        title="Copy your key"
        lede="You won't see it again. Store it where your script or tool can read it."
      />
      <RowGroup>
        <Row
          title="Key"
          description="Secret"
          descriptionId="key-secret"
          buttons={
            <Button kind="quiet" icon="copy" hidden data={{ "key-copy": "" }}>
              Copy
            </Button>
          }
        />
      </RowGroup>
      <FormFoot>
        <Button kind="primary" href={KEYS_HREF} hook="key-done">
          Done
        </Button>
      </FormFoot>
    </section>
  );
}

export function CreateKeyPage(props: CreateKeyParams) {
  return (
    <ConsolePage
      title="Create key"
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[KEYS_TRAIL, { label: "Create key" }]}
      pageId="keys"
    >
      <form
        class="stack-24"
        method="post"
        action={NEW_KEY_HREF}
        novalidate
        data-access
        data-key-form="create"
        data-reason-name={CREATE_REASONS.name}
        data-reason-access={CREATE_REASONS.access}
        data-confirm-why="Making a key lets something new reach your data."
      >
        <PageHeader
          title="Create key"
          lede="A key lets a script or tool use Marfa. It starts with nothing: turn on only what it needs."
        />
        <ProblemNotice />
        <Section
          id="details"
          title="Details"
          description="Name it after what will use it."
        >
          <RowGroup>
            <Row
              title="Name"
              description="Shown in API keys and in Activity"
              descriptionId="key-name-note"
              for="key-name"
              data={{ "note-error": CREATE_REASONS.name }}
              control={
                <RowInput
                  id="key-name"
                  name="label"
                  placeholder="backup-script"
                  maxlength={200}
                  describedBy="key-name-note"
                />
              }
            />
            <Row
              title="Ends"
              description="Counted from today"
              for="key-ends"
              control={
                <Select
                  id="key-ends"
                  name="ends"
                  label="Ends"
                  value="never"
                  options={END_OPTIONS}
                />
              }
            />
          </RowGroup>
        </Section>
        {offersChoice(props.access) ? (
          <Section
            id="access"
            title="Access"
            description="What it can read and change."
          >
            <AccessChoices model={props.access} />
          </Section>
        ) : null}
        <Section
          id="advanced"
          title="Advanced"
          description="Most keys don't need these."
        >
          <RowGroup>
            <Row
              title="Source it writes as"
              description="Items it adds are marked with this. Can't be changed later."
              for="key-source"
              control={
                <RowInput
                  id="key-source"
                  name="source"
                  placeholder="Same as the name"
                  maxlength={200}
                />
              }
            />
            <Row
              title="Other sources it may write as"
              description="Separate them with commas"
              for="key-sources"
              control={
                <RowInput
                  id="key-sources"
                  name="sources"
                  placeholder="None"
                  maxlength={1000}
                />
              }
            />
            <Row
              title="Where its items land"
              description="When it doesn't say"
              for="key-tier"
              control={
                <Select
                  id="key-tier"
                  name="default_tier"
                  label="Where its items land"
                  value="library"
                  options={[
                    { value: "library", label: "Library" },
                    { value: "feed", label: "Feed" },
                  ]}
                />
              }
            />
            <Row
              title="Marfa's write rules"
              description="Skipping them lets the key write what they would refuse"
              for="key-rules"
              control={
                <Select
                  id="key-rules"
                  name="rules"
                  label="Marfa's write rules"
                  value="follow"
                  options={[
                    { value: "follow", label: "Follow them" },
                    { value: "skip", label: "Skip them" },
                  ]}
                />
              }
            />
            <Row
              title={ALL_EXTENSIONS.title}
              description="What integrations attach to your items. Follows Access until you choose."
              for="key-extensions"
              control={
                <Select
                  id="key-extensions"
                  name="extensions"
                  label={ALL_EXTENSIONS.title}
                  value="none"
                  options={EXTENSION_OPTIONS}
                  data={{ "ext-noun": ALL_EXTENSIONS.noun }}
                />
              }
            />
          </RowGroup>
        </Section>
        <FormFoot note={<span data-reason>{CREATE_REASONS.name}</span>}>
          <Button kind="outline" href={KEYS_HREF}>
            Cancel
          </Button>
          <Button
            kind="primary"
            type="submit"
            ariaDisabled
            loadingLabel="Creating..."
            hook="key-submit"
          >
            Create key
          </Button>
        </FormFoot>
      </form>
      <CopyView />
    </ConsolePage>
  );
}

export const renderCreateKeyPage = (params: CreateKeyParams): string =>
  renderDocument(<CreateKeyPage {...params} />);

// ---------------------------------------------------------------------------
// Copy your key, after a reload or a second visit
// ---------------------------------------------------------------------------

export interface GoneKeyParams extends PageBase {
  /** Whether the key still exists, which decides where the page sends the person. */
  keyId?: string;
}

/** Where a new key's secret was shown once; reached again, it can only say so. */
export function GoneKeyPage(props: GoneKeyParams) {
  return (
    <ConsolePage
      title="Copy your key"
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[KEYS_TRAIL, { label: "Copy your key" }]}
      pageId="keys"
    >
      <div class="stack-24">
        <PageHeader title="Copy your key" />
        <RowGroup>
          <EmptyState
            title="This key can't be shown again"
            description="A key is shown once, when it's made. If you didn't save it, revoke the key and make a new one."
            action={
              <Button
                kind="outline"
                href={
                  props.keyId === undefined ? KEYS_HREF : keyHref(props.keyId)
                }
              >
                {props.keyId === undefined ? "Go to API keys" : "Go to the key"}
              </Button>
            }
          />
        </RowGroup>
      </div>
    </ConsolePage>
  );
}

export const renderGoneKeyPage = (params: GoneKeyParams): string =>
  renderDocument(<GoneKeyPage {...params} />);

/** What the person meets at the address of a key that is not there: revoked, expired, or never made. */
export function MissingKeyPage(props: PageBase) {
  return (
    <ConsolePage
      title="API keys"
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[KEYS_TRAIL, { label: "Not found" }]}
      pageId="keys"
    >
      <div class="stack-24">
        <PageHeader title="This key isn't here" />
        <RowGroup>
          <EmptyState
            title="It may have been revoked or may have ended"
            description="Keys that are gone are not listed."
            action={
              <Button kind="outline" href={KEYS_HREF}>
                Go to API keys
              </Button>
            }
          />
        </RowGroup>
      </div>
    </ConsolePage>
  );
}

export const renderMissingKeyPage = (params: PageBase): string =>
  renderDocument(<MissingKeyPage {...params} />);

// ---------------------------------------------------------------------------
// A key
// ---------------------------------------------------------------------------

/** One line of the Details section. */
export interface KeyDetail {
  title: string;
  value: string;
}

export interface KeyPageParams extends PageBase {
  id: string;
  label: string;
  /** The name of the app that made the key, or `undefined` for a key the owner made. */
  madeBy?: { name: string | null; connected: boolean };
  /** The lines under Details, in order. */
  details: readonly KeyDetail[];
  /**
   * The Ends select: the key's current end in words (`null` when it has none),
   * the same end as a time, and the ends it may be moved to, none later than it.
   */
  ends: {
    current: string | null;
    iso: string | null;
    choices: readonly EndChoice[];
  };
  /** What the key held when the page was drawn, which a save compares with the key as it is then. */
  loaded: string;
  /** The controls at the most the key holds, or `undefined` when it holds nothing. */
  access: AccessModel | undefined;
  /** What the key is denied beside a wider grant, written for the person, and the raw names the script sends back. */
  denied: { words: readonly string[]; keep: string };
  /** Keys to list in the picker beside the page. */
  siblings: readonly RegistryItem[];
}

export function KeyPage(props: KeyPageParams) {
  const lede =
    props.madeBy === undefined
      ? "You can give it less access, not more. To give more, make a new key."
      : `Made by ${props.madeBy.name ?? "an app"}. You can give it less access, not more.`;
  const endOptions = [
    ...(props.ends.current === null
      ? []
      : [{ value: "current", label: props.ends.current }]),
    ...END_OPTIONS.filter((option) =>
      props.ends.choices.includes(option.value),
    ),
  ];
  return (
    <ConsolePage
      title={props.label}
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[KEYS_TRAIL, { label: props.label }]}
      pageId="keys"
      items={{ keys: props.siblings }}
      currentItemHref={keyHref(props.id)}
    >
      <form
        id="key-form"
        class="stack-24"
        method="post"
        action={keyHref(props.id)}
        novalidate
        data-access
        data-key-form="edit"
        data-key-id={props.id}
        data-key-label={props.label}
        data-keep={props.denied.keep}
        data-loaded={props.loaded}
        data-confirm-why="Changing a key needs a recent sign-in."
      >
        <PageHeader title={props.label} lede={lede} />
        <div data-notice="flash" hidden>
          <Notice>
            <span data-notice-text></span>
          </Notice>
        </div>
        <ProblemNotice />
        <Section
          id="details"
          title="Details"
          description="What it writes as, and when it was last used."
        >
          <RowGroup>
            {props.details.map((detail) => (
              <Row title={detail.title} value={detail.value} valueAuto />
            ))}
            <Row
              title="Ends"
              description="A new end date counts from the day you save"
              for="key-ends"
              control={
                <Select
                  id="key-ends"
                  name="ends"
                  label="Ends"
                  value={props.ends.current === null ? "never" : "current"}
                  options={endOptions}
                  data={{
                    initial: props.ends.current === null ? "never" : "current",
                    ...(props.ends.iso === null
                      ? {}
                      : { "current-iso": props.ends.iso }),
                  }}
                />
              }
            />
          </RowGroup>
        </Section>
        {props.access !== undefined && offersChoice(props.access) ? (
          <Section
            id="access"
            title="Access"
            description="What it can read and change."
          >
            <AccessChoices model={props.access} />
            {props.denied.words.length > 0 && (
              <RowGroup>
                <Row
                  title="No access to"
                  description={props.denied.words.join(", ")}
                  valueAuto
                />
              </RowGroup>
            )}
          </Section>
        ) : (
          <Section
            id="access"
            title="Access"
            description="What it can read and change."
          >
            <RowGroup>
              <EmptyState
                title="No access"
                description="This key can't read or change anything."
              />
            </RowGroup>
          </Section>
        )}
      </form>
      <DangerRow
        title="Revoke this key"
        description="Scripts using it stop working at once. Can't be undone."
        action={
          <Button kind="danger-quiet" opens="key-revoke-dialog">
            Revoke
          </Button>
        }
      />
      <SaveBar form="key-form" />
      <Dialog
        id="key-revoke-dialog"
        title={`Revoke ${props.label}?`}
        description="Scripts using it stop working at once. This can't be undone."
        data={{
          "key-id": props.id,
          "key-label": props.label,
          "confirm-why": "Revoking a key needs a recent sign-in.",
        }}
        actions={
          <>
            <Button kind="outline" closes>
              Cancel
            </Button>
            <Button kind="danger" loadingLabel="Revoking..." hook="key-revoke">
              Revoke
            </Button>
          </>
        }
      >
        <div data-notice="revoke-problem" hidden>
          <Notice tone="error">
            <span data-notice-text></span>
          </Notice>
        </div>
      </Dialog>
    </ConsolePage>
  );
}

export const renderKeyPage = (params: KeyPageParams): string =>
  renderDocument(<KeyPage {...params} />);

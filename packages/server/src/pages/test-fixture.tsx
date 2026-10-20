/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * A page that uses every part, for the tests that look at the parts together.
 * Production code does not import it.
 */
import { Breadcrumb } from "./parts/breadcrumb.js";
import { CommandSearch } from "./parts/command-search.js";
import { Button, Select, Switch } from "./parts/controls.js";
import { Dialog } from "./parts/dialog.js";
import { EmptyState, Notice } from "./parts/feedback.js";
import {
  FormFoot,
  PasswordField,
  SearchField,
  TextField,
} from "./parts/fields.js";
import {
  ConsoleColumn,
  MomentCard,
  PageHeader,
  Section,
} from "./parts/layout.js";
import { ListToolbar, Pager, Tabs } from "./parts/list.js";
import { ClosingAction, Row, RowGroup } from "./parts/rows.js";
import { PageShell } from "./parts/shell.js";
import { paginate, type PageSize } from "./navigation.js";
import { renderDocument } from "./render.js";
import {
  HOME_GROUPS,
  createPageRegistry,
  type PageRegistry,
  type RegistryItem,
} from "./registry.js";

/** Text that would break a page that did not escape it. */
export const HOSTILE = `<script>window.__injected = 1</script> "quoted" 'single' & <b>bold</b>`;

/** A name with no place to break, as a long address or instance name can be. */
export const LONG_UNBROKEN =
  "an-instance-name-that-is-far-too-long-to-fit-on-a-phone-screen-without-a-break-in-it.example.invalid";

const KEY_ITEMS: readonly RegistryItem[] = Array.from(
  { length: 12 },
  (_, i) => ({
    title: `Key number ${String(i + 1)}`,
    href: `/fixture/keys/${String(i + 1)}`,
  }),
);

export function fixtureRegistry(): PageRegistry {
  const registry = createPageRegistry(HOME_GROUPS);
  registry.register("keys", { href: "/fixture/keys", hasItems: true });
  registry.register("apps", { href: "/fixture/apps", hasItems: true });
  registry.register("items", { href: "/fixture/items" });
  registry.register("trash", { href: "/fixture/trash" });
  registry.register("settings", {
    href: "/fixture/settings",
    settings: [
      {
        id: "trash_days",
        title: "Keep items in the trash",
        description: "After this, they are deleted for good",
        group: "Keeping things",
        href: "/fixture/settings#trash",
      },
      {
        id: "hostile",
        title: HOSTILE,
        group: "Testing",
        href: "/fixture/settings#hostile",
      },
    ],
  });
  return registry;
}

const ROWS = Array.from({ length: 23 }, (_, i) => i + 1);

export interface FixtureOptions {
  nonce: string;
  page?: number;
  size?: PageSize;
}

export function FixturePage(props: FixtureOptions) {
  const registry = fixtureRegistry();
  const pagination = paginate(ROWS.length, props.page ?? 1, props.size);
  return (
    <PageShell title="Fixture page" nonce={props.nonce}>
      <Breadcrumb
        home={{ label: LONG_UNBROKEN, href: "/fixture" }}
        trail={[
          { label: "API keys", href: "/fixture/keys" },
          { label: "Key number 3" },
        ]}
        registry={registry}
        pageId="keys"
        items={{
          keys: KEY_ITEMS,
          apps: [{ title: "Loop", href: "/fixture/apps/1" }],
        }}
        currentItemHref="/fixture/keys/3"
      />
      <CommandSearch registry={registry} home={{ href: "/fixture" }} />
      <ConsoleColumn>
        <div class="stack-24">
          <PageHeader
            title={LONG_UNBROKEN}
            lede={`Reached at ${LONG_UNBROKEN} and ${HOSTILE}`}
            action={
              <Button kind="primary" href="/fixture/keys/new">
                Create key
              </Button>
            }
          />
          <SearchField placeholder="Search settings" full shortcutHint />
        </div>

        <Section
          id="rows"
          title="Rows"
          description="One of each kind of row end."
        >
          <RowGroup>
            <Row
              title="A link row"
              description="Ends in a value and a chevron"
              value="3 keys"
              href="/fixture/keys"
            />
            <Row
              title="Opens a dialog"
              description="Ends in a chevron"
              opens="confirm"
            />
            <Row
              title="A control row"
              description="Ends in a select"
              for="speed"
              control={
                <Select
                  id="speed"
                  value="b"
                  options={[
                    { value: "a", label: "Slow" },
                    { value: "b", label: "Steady" },
                    { value: "c", label: "Fast" },
                  ]}
                />
              }
            />
            <Row
              title="A switch row"
              for="notes"
              control={<Switch id="notes" checked />}
            />
            <Row
              title="A buttons row"
              description="Ends in buttons"
              buttons={
                <>
                  <Button kind="outline">Edit</Button>
                  <Button kind="danger-quiet">Remove</Button>
                </>
              }
            />
            <Row title="A value row" value={LONG_UNBROKEN} />
            <Row
              title={HOSTILE}
              description={HOSTILE}
              descriptionTone="danger"
              value={HOSTILE}
              valueTone="danger"
            />
          </RowGroup>
        </Section>

        <Section
          id="form"
          title="Form"
          description="Fields, then the form foot."
          control={<Button kind="quiet">Reset</Button>}
        >
          <form method="post" action="/fixture/form" novalidate class="stack">
            <TextField
              id="name"
              name="name"
              label="Name"
              hint="Shown to apps."
              value={HOSTILE}
              required
              full
            />
            <TextField
              id="email"
              name="email"
              label="Email"
              type="email"
              error="Enter a valid email address."
              full
            />
            <PasswordField
              id="password"
              name="password"
              label="Password"
              labelEnd={<a href="/fixture/forgot">Forgot?</a>}
              full
              required
            />
            <FormFoot note="Changes save when you press Save.">
              <Button kind="outline">Cancel</Button>
              <Button kind="primary" type="submit" loadingLabel="Saving...">
                Save
              </Button>
            </FormFoot>
          </form>
        </Section>

        <Section id="notices" title="Notices">
          <div class="stack">
            <Notice title="Heads up">
              Nothing is wrong, this is for information.
            </Notice>
            <Notice
              tone="error"
              title="That did not work"
              action={<Button kind="danger-quiet">Retry</Button>}
            >
              {HOSTILE}
            </Notice>
            <RowGroup>
              <EmptyState
                title="Nothing here yet"
                description="Create a key for a script or tool."
                action={<Button kind="primary">Create key</Button>}
              />
            </RowGroup>
          </div>
        </Section>

        <Section id="list" title="A long list">
          <div class="stack">
            <Tabs
              label="Keys"
              tabs={[
                {
                  label: "Your keys",
                  href: "?kind=you",
                  current: true,
                  count: 23,
                },
                {
                  label: "Made by apps",
                  href: "?kind=apps",
                  current: false,
                  count: 4,
                },
              ]}
            />
            <ListToolbar
              label="Search keys"
              filters={
                <Select
                  name="state"
                  label="State"
                  auto
                  autosubmit
                  options={[
                    { value: "", label: "Any state" },
                    { value: "active", label: "Active" },
                  ]}
                />
              }
              search={<SearchField placeholder="Search keys" />}
            />
            <RowGroup oneLine>
              {ROWS.slice(pagination.from, pagination.to).map((n) => (
                <Row
                  title={`Key ${String(n)}`}
                  description={`A fairly long line of description for key ${String(n)} that has to be cut short with an ellipsis at the end`}
                  value="Used today"
                  href={`/fixture/keys/${String(n)}`}
                />
              ))}
            </RowGroup>
            <Pager
              pagination={pagination}
              noun="keys"
              href={(page) =>
                `?page=${String(page)}&size=${String(pagination.size)}`
              }
            />
          </div>
        </Section>

        <ClosingAction>
          <Row
            title="Sign out other browsers"
            description="Ends every sign-in but this one"
            buttons={
              <Button kind="danger-quiet" opens="confirm">
                Sign out others
              </Button>
            }
          />
        </ClosingAction>
      </ConsoleColumn>
      <Dialog
        id="confirm"
        title="Sign out other browsers?"
        description="They will need to sign in again."
        actions={
          <>
            <Button kind="outline" closes>
              Cancel
            </Button>
            <Button kind="danger" closes>
              Sign out
            </Button>
          </>
        }
      >
        <TextField id="confirm-note" name="note" label="Note" full />
      </Dialog>
    </PageShell>
  );
}

export function renderFixturePage(options: FixtureOptions): string {
  return renderDocument(<FixturePage {...options} />);
}

/** A moment card with every slot filled, for the tests that look at it alone. */
export function MomentFixture(props: { nonce: string }) {
  return (
    <PageShell title="Moment fixture" nonce={props.nonce}>
      <MomentCard
        title={LONG_UNBROKEN}
        lede={HOSTILE}
        ledeRole="status"
        foot={LONG_UNBROKEN}
      >
        <Button kind="primary" wide href="/">
          Go to Home
        </Button>
      </MomentCard>
    </PageShell>
  );
}

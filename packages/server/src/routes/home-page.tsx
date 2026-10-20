/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * Home: where the owner lands, and the one page that lists the rest. The
 * pages come from the registry, grouped as it groups them, each with the value
 * the page registered for it; what needs a look comes from the pages too. Home
 * names no page itself except the interim row below.
 */
import { renderDocument } from "../pages/render.js";
import {
  Button,
  ConsolePage,
  EmptyState,
  HOME_HREF,
  Notice,
  PageHeader,
  Row,
  RowGroup,
  SearchField,
  Section,
} from "../pages/parts/index.js";
import { HOME_GROUPS } from "../pages/registry.js";
import type { BuiltGroup, PageRegistry } from "../pages/registry.js";
import type { HomeReading } from "./console.js";

/** The longest search Home takes. Longer is cut, so a page never echoes a whole request. */
export const MAX_HOME_SEARCH = 200;
/** The most settings a search lists, so one broad word does not list every setting. */
const MAX_SETTING_HITS = 8;

/**
 * REMOVE with the pages it stands in for. Until Access, Your data,
 * Connections and This Marfa have their own pages, the one management page
 * holds what they will. It sits in This Marfa and is not a registered page, so
 * the picker and the search never offer it.
 */
const OLDER_MANAGEMENT_PAGE = {
  groupId: "marfa",
  title: "Older management page",
  description: "Keys, apps, connectors, sign-ins and restore, all on one page",
  href: "/auth/owner/manage",
} as const;

export interface HomePageParams {
  nonce: string;
  instanceName: string;
  /** Where this Marfa is reached, without the scheme. */
  address: string;
  registry: PageRegistry;
  reading: HomeReading;
  /** What the person searched for, already trimmed. */
  query?: string;
}

/** Cuts a search to what Home takes. */
export function homeSearchQuery(raw: string | undefined): string {
  return Array.from((raw ?? "").trim())
    .slice(0, MAX_HOME_SEARCH)
    .join("");
}

interface HomeRow {
  title: string;
  description: string;
  href: string;
  value?: string;
  valueTone?: "warn" | "danger";
}

interface HomeSection {
  id: string;
  title: string;
  rows: HomeRow[];
}

function sections(registry: PageRegistry, reading: HomeReading): HomeSection[] {
  const built: readonly BuiltGroup[] = registry.groups();
  const rowsOf = (group: BuiltGroup): HomeRow[] =>
    group.pages.map((page) => {
      const value = reading.values.get(page.id);
      return {
        title: page.title,
        description: page.description,
        href: page.href,
        value: value?.text,
        valueTone: value?.tone,
      };
    });
  const result: HomeSection[] = built.map((group) => ({
    id: group.id,
    title: group.title,
    rows: rowsOf(group),
  }));
  const interim: HomeRow = {
    title: OLDER_MANAGEMENT_PAGE.title,
    description: OLDER_MANAGEMENT_PAGE.description,
    href: OLDER_MANAGEMENT_PAGE.href,
  };
  const own = result.find((s) => s.id === OLDER_MANAGEMENT_PAGE.groupId);
  if (own) own.rows.push(interim);
  else {
    const order = HOME_GROUPS.map((g) => g.id);
    const at = order.indexOf(OLDER_MANAGEMENT_PAGE.groupId);
    const later = result.findIndex((s) => order.indexOf(s.id) > at);
    const added: HomeSection = {
      id: OLDER_MANAGEMENT_PAGE.groupId,
      title: HOME_GROUPS[at]?.title ?? "This Marfa",
      rows: [interim],
    };
    result.splice(later === -1 ? result.length : later, 0, added);
  }
  return result;
}

function Results(props: {
  registry: PageRegistry;
  reading: HomeReading;
  query: string;
}) {
  const found = props.registry.search(props.query);
  const rows: HomeRow[] = [
    ...found.pages.map((hit) => {
      const value = props.reading.values.get(hit.id);
      return {
        title: hit.title,
        description: `${hit.group}. ${hit.description}`,
        href: hit.href,
        value: value?.text,
        valueTone: value?.tone,
      };
    }),
    ...found.settings.slice(0, MAX_SETTING_HITS).map((hit) => ({
      title: hit.title,
      description: `${hit.page}. ${hit.group}`,
      href: hit.href,
    })),
  ];
  return (
    <Section id="results" title={`Results for “${props.query}”`}>
      <RowGroup oneLine>
        {rows.length === 0 ? (
          <EmptyState
            title="No results"
            description="Try another word, or look in All settings."
          />
        ) : (
          rows.map((row) => <Row {...row} />)
        )}
      </RowGroup>
    </Section>
  );
}

export function HomePage(props: HomePageParams) {
  const query = props.query ?? "";
  const attention = props.reading.attention;
  return (
    <ConsolePage
      title={props.instanceName}
      nonce={props.nonce}
      instanceName={props.instanceName}
      registry={props.registry}
    >
      <div class="stack-24">
        <PageHeader
          title={props.instanceName}
          lede={props.address}
          action={
            <Button kind="quiet" data={{ "sign-out": "" }} hidden>
              Sign out
            </Button>
          }
        />
        <div data-notice="sign-out" hidden>
          <Notice tone="error">
            <span data-notice-text></span>
          </Notice>
        </div>
        <form method="get" action={HOME_HREF} role="search">
          <SearchField
            placeholder="Search settings"
            value={query === "" ? undefined : query}
            full
            shortcutHint
          />
        </form>
      </div>
      {query !== "" ? (
        <Results
          registry={props.registry}
          reading={props.reading}
          query={query}
        />
      ) : (
        <>
          {attention.length > 0 && (
            <Section id="attention" title="Needs attention">
              <RowGroup>
                {attention.map((item) => (
                  <Row
                    title={item.title}
                    description={item.description}
                    href={item.href}
                    dot={item.tone ?? "warn"}
                  />
                ))}
              </RowGroup>
            </Section>
          )}
          {sections(props.registry, props.reading).map((section) => (
            <Section id={section.id} title={section.title}>
              <RowGroup oneLine>
                {section.rows.map((row) => (
                  <Row {...row} />
                ))}
              </RowGroup>
            </Section>
          ))}
        </>
      )}
    </ConsolePage>
  );
}

export function renderHomePage(params: HomePageParams): string {
  return renderDocument(<HomePage {...params} />);
}

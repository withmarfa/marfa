/**
 * The pages of the console, for the breadcrumb's picker and the command
 * search.
 *
 * A page is defined here by what a person reads about it (its name, its line
 * and the group it sits in) and becomes a link only when the code that serves
 * it registers it. Until then it has no address, so nothing can render it as a
 * link: the picker and the search read `groups()` and `search()`, which
 * return built pages only.
 */
import { matchesQuery, rankMatches } from "./navigation.js";

export interface PageDefinition {
  id: string;
  title: string;
  /** The line under the name in the search, and the text it matches. */
  description: string;
  /** Offered in the command search before anything is typed. */
  suggested?: boolean;
}

export interface GroupDefinition {
  id: string;
  title: string;
  pages: readonly PageDefinition[];
}

/** A setting the command search can take a person to. */
export interface RegistrySetting {
  id: string;
  title: string;
  description?: string;
  /** The group of settings it belongs to, as the settings page shows it. */
  group: string;
  href: string;
}

/** An item inside a page, listed in the picker's side panel. */
export interface RegistryItem {
  title: string;
  href: string;
}

export interface Registration {
  /** A path on this server. */
  href: string;
  /** The page has items one level down, which the picker lists beside it. */
  hasItems?: boolean;
  settings?: readonly RegistrySetting[];
}

export interface BuiltPage extends PageDefinition {
  href: string;
  hasItems: boolean;
  settings: readonly RegistrySetting[];
}

export interface BuiltGroup {
  id: string;
  title: string;
  pages: readonly BuiltPage[];
}

export interface PageHit {
  id: string;
  title: string;
  description: string;
  href: string;
  /** The title of the group the page sits in. */
  group: string;
}

export interface SettingHit extends RegistrySetting {
  /** The title of the page the setting lives on. */
  page: string;
}

export interface SearchResult {
  pages: PageHit[];
  settings: SettingHit[];
}

export interface PageRegistry {
  /** Mark a page built, with the address it is served at. */
  register(id: string, registration: Registration): void;
  /** The groups that hold at least one built page, in definition order. */
  groups(): readonly BuiltGroup[];
  page(id: string): BuiltPage | undefined;
  /** Built pages the search offers before anything is typed. */
  suggested(): readonly PageHit[];
  search(query: string): SearchResult;
}

/** A path on this server: one slash first, and not the start of another host. */
function isLocalPath(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//") && !href.includes("\\");
}

export function createPageRegistry(
  definitions: readonly GroupDefinition[],
): PageRegistry {
  const known = new Map<
    string,
    { group: GroupDefinition; page: PageDefinition }
  >();
  for (const group of definitions)
    for (const page of group.pages) {
      if (known.has(page.id))
        throw new Error(`Duplicate page id in the registry: ${page.id}`);
      known.set(page.id, { group, page });
    }
  const built = new Map<string, BuiltPage>();

  const builtGroups = (): BuiltGroup[] =>
    definitions
      .map((group) => ({
        id: group.id,
        title: group.title,
        pages: group.pages.flatMap((p) => {
          const page = built.get(p.id);
          return page ? [page] : [];
        }),
      }))
      .filter((group) => group.pages.length > 0);

  const hit = (page: BuiltPage): PageHit => ({
    id: page.id,
    title: page.title,
    description: page.description,
    href: page.href,
    group: known.get(page.id)?.group.title ?? "",
  });

  return {
    register(id, registration) {
      const entry = known.get(id);
      if (!entry) throw new Error(`Unknown page: ${id}`);
      if (built.has(id)) throw new Error(`Page already registered: ${id}`);
      if (!isLocalPath(registration.href))
        throw new Error(
          `A page's address must be a path on this server: ${id}`,
        );
      const settings = registration.settings ?? [];
      if (new Set(settings.map((s) => s.id)).size !== settings.length)
        throw new Error(`Duplicate setting id on page ${id}`);
      for (const setting of settings)
        if (!isLocalPath(setting.href))
          throw new Error(
            `A setting's address must be a path on this server: ${setting.id}`,
          );
      built.set(id, {
        ...entry.page,
        href: registration.href,
        hasItems: registration.hasItems ?? false,
        settings,
      });
    },
    groups: builtGroups,
    page: (id) => built.get(id),
    suggested() {
      return builtGroups()
        .flatMap((group) => group.pages)
        .filter((page) => page.suggested)
        .map(hit);
    },
    search(query) {
      const pages = builtGroups().flatMap((group) =>
        group.pages.map((page) => ({
          hit: hit(page),
          haystack: `${page.title} ${page.description} ${group.title}`,
        })),
      );
      const settings = builtGroups().flatMap((group) =>
        group.pages.flatMap((page) =>
          page.settings
            .filter((s) =>
              matchesQuery(
                query,
                `${s.title} ${s.description ?? ""} ${s.id} ${s.group}`,
              ),
            )
            .map((s): SettingHit => ({ ...s, page: page.title })),
        ),
      );
      const rankedPages = rankMatches(
        query,
        pages.map((p) => ({ title: p.hit.title, haystack: p.haystack })),
      ).map((i) => pages[i]?.hit);
      const rankedSettings = rankMatches(
        query,
        settings.map((s) => ({
          title: s.title,
          haystack: `${s.title} ${s.description ?? ""} ${s.id} ${s.group}`,
        })),
      ).map((i) => settings[i]);
      return {
        pages: rankedPages.filter((p): p is PageHit => p !== undefined),
        settings: rankedSettings.filter(
          (s): s is SettingHit => s !== undefined,
        ),
      };
    },
  };
}

/** Home's groups, as the console shows them. */
export const HOME_GROUPS: readonly GroupDefinition[] = [
  {
    id: "access",
    title: "Access",
    pages: [
      {
        id: "keys",
        title: "API keys",
        description: "Let scripts and tools use Marfa",
        suggested: true,
      },
      {
        id: "apps",
        title: "Connected apps",
        description: "Apps you've approved, and what each can access",
        suggested: true,
      },
      {
        id: "browsers",
        title: "Browsers",
        description: "Where you're signed in to these pages",
      },
    ],
  },
  {
    id: "data",
    title: "Your data",
    pages: [
      {
        id: "items",
        title: "Items",
        description: "Everything in Marfa, by type",
        suggested: true,
      },
      {
        id: "trash",
        title: "Trash",
        description: "Deleted items, kept for a while",
        suggested: true,
      },
      {
        id: "export",
        title: "Export and restore",
        description: "Download everything, or bring an export back",
      },
    ],
  },
  {
    id: "connections",
    title: "Connections",
    pages: [
      {
        id: "connectors",
        title: "Connectors",
        description: "Bring data in from other services",
      },
      {
        id: "folders",
        title: "Folders",
        description: "Folders kept in step with Marfa on your Macs",
      },
    ],
  },
  {
    id: "marfa",
    title: "This Marfa",
    pages: [
      {
        id: "general",
        title: "General",
        description: "Name, and how long things are kept",
      },
      {
        id: "health",
        title: "Health",
        description: "How Marfa is running, and its housekeeping",
      },
      {
        id: "activity",
        title: "Activity",
        description: "Every change, and what made it",
      },
      {
        id: "settings",
        title: "All settings",
        description: "Every setting, by group",
        suggested: true,
      },
    ],
  },
  {
    id: "you",
    title: "You",
    pages: [
      {
        id: "profile",
        title: "Profile",
        description: "Your name, email and picture",
      },
      {
        id: "password",
        title: "Password and passkeys",
        description: "How you sign in",
      },
    ],
  },
];

/** The registry the console's pages register into. */
export const PAGE_REGISTRY: PageRegistry = createPageRegistry(HOME_GROUPS);

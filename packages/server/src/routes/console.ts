/**
 * How a console page tells Home about itself.
 *
 * A page registers once, beside its entry in the page registry, with the
 * address it is served at and, if it has them, two things Home shows: its
 * current value (the right end of its row) and its attention items (the
 * Needs attention list). Home reads both when it renders, so adding a page
 * never edits Home. The registry itself holds no storage; the providers that
 * read it live here, in the routes layer.
 */
import { PAGE_REGISTRY } from "../pages/registry.js";
import type { PageRegistry, Registration } from "../pages/registry.js";
import type { AppConfig } from "../config.js";
import type { Storage } from "../storage/interface.js";

/** What Home's row for a page says at its right end. */
export interface HomeValue {
  text: string;
  /** Only for a value a person should act on. */
  tone?: "warn" | "danger";
}

/** One line in Needs attention: what is wrong, and where to put it right. */
export interface AttentionItem {
  title: string;
  /** What it means for the person, in a short sentence. */
  description?: string;
  /** A path on this server. */
  href: string;
  tone?: "warn" | "danger";
}

/** What a provider may read. */
export interface ConsoleReads {
  storage: Storage;
  config: AppConfig;
}

export interface ConsoleRegistration extends Registration {
  /** The page's current value, or nothing when it has none worth saying. */
  value?: (reads: ConsoleReads) => Promise<HomeValue | undefined>;
  /** What is wrong on the page, if anything. Empty when nothing is. */
  attention?: (reads: ConsoleReads) => Promise<readonly AttentionItem[]>;
}

export interface HomeReading {
  /** The value of each registered page that has one, by page id. */
  values: ReadonlyMap<string, HomeValue>;
  attention: readonly AttentionItem[];
}

export interface ConsolePages {
  readonly registry: PageRegistry;
  /** Mark a page built and attach what Home shows for it. Once per page. */
  register(id: string, registration: ConsoleRegistration): void;
  /**
   * Ask every registered page for its value and its attention items, all at
   * once. A page that fails to answer never takes Home down with it: its
   * value is left out, and an attention failure becomes an item that says the
   * page could not be checked.
   */
  read(reads: ConsoleReads): Promise<HomeReading>;
}

export function createConsolePages(registry: PageRegistry): ConsolePages {
  const providers = new Map<
    string,
    Pick<ConsoleRegistration, "value" | "attention">
  >();
  return {
    registry,
    register(id, { value, attention, ...registration }) {
      registry.register(id, registration);
      providers.set(id, { value, attention });
    },
    async read(reads) {
      const values = new Map<string, HomeValue>();
      const lists = await Promise.all(
        [...providers].map(async ([id, provider]) => {
          const page = registry.page(id);
          if (!page) return [];
          const [value, attention] = await Promise.allSettled([
            provider.value?.(reads),
            provider.attention?.(reads),
          ]);
          if (value.status === "fulfilled" && value.value !== undefined)
            values.set(id, value.value);
          if (attention.status === "rejected")
            return [
              {
                title: `Couldn't check ${page.title}`,
                href: page.href,
                tone: "warn",
              } satisfies AttentionItem,
            ];
          return attention.value ?? [];
        }),
      );
      return { values, attention: lists.flat() };
    },
  };
}

/** The console's own pages: what the picker, the search and Home read. */
export const CONSOLE_PAGES: ConsolePages = createConsolePages(PAGE_REGISTRY);

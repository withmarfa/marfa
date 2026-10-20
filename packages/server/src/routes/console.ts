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
import { errorMessage } from "../error-text.js";
import { localHref } from "../pages/href.js";
import { PAGE_REGISTRY } from "../pages/registry.js";
import type { PageRegistry, Registration } from "../pages/registry.js";
import type { AppConfig } from "../config.js";
import type { MarfaAuth } from "../auth/instance.js";
import { log } from "../middleware/logger.js";
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
  /** Present where the owner can sign in; a page that reads sign-ins leaves its value out without it. */
  auth?: MarfaAuth;
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

/** How long Home waits for one page's value or attention items. */
const PROVIDER_DEADLINE_MS = 2000;

const TONES: readonly unknown[] = ["warn", "danger"];

/** Runs `provider` and gives up on it at the deadline. Its timer never outlives it. */
async function withinDeadline<T>(provider: () => Promise<T> | T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no answer within ${String(PROVIDER_DEADLINE_MS)} ms`));
    }, PROVIDER_DEADLINE_MS);
  });
  try {
    // Started from a promise so a provider that throws before it returns one
    // is a rejection like any other.
    return await Promise.race([Promise.resolve().then(provider), late]);
  } finally {
    clearTimeout(timer);
  }
}

function checkedValue(value: HomeValue | undefined): HomeValue | undefined {
  if (value === undefined) return undefined;
  if (typeof value.text !== "string") throw new Error("a value must have text");
  if (value.tone !== undefined && !TONES.includes(value.tone))
    throw new Error(`unknown tone ${JSON.stringify(value.tone)}`);
  return value;
}

/** Checks one item the way Home will render it, so rendering cannot throw on it. */
function checkedItem(item: AttentionItem): AttentionItem {
  if (typeof item.title !== "string")
    throw new Error("an attention item must have a title");
  if (item.description !== undefined && typeof item.description !== "string")
    throw new Error("an attention item's description must be text");
  if (item.tone !== undefined && !TONES.includes(item.tone))
    throw new Error(`unknown tone ${JSON.stringify(item.tone)}`);
  localHref(item.href);
  return item;
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
            withinDeadline(async () =>
              checkedValue(await provider.value?.(reads)),
            ),
            withinDeadline(async (): Promise<readonly AttentionItem[]> => {
              const items: unknown = await provider.attention?.(reads);
              if (items === undefined) return [];
              if (!Array.isArray(items))
                throw new Error("attention must be a list");
              return items as AttentionItem[];
            }),
          ]);
          let failures = 0;
          const fail = (error: unknown): void => {
            failures += 1;
            log("warn", "console: a page could not be read for Home", {
              page: id,
              error: errorMessage(error),
            });
          };
          if (value.status === "fulfilled") {
            if (value.value !== undefined) values.set(id, value.value);
          } else fail(value.reason);
          const items: AttentionItem[] = [];
          if (attention.status === "fulfilled") {
            for (const item of attention.value) {
              try {
                items.push(checkedItem(item));
              } catch (error) {
                fail(error);
              }
            }
          } else fail(attention.reason);
          if (failures > 0)
            items.push({
              title: `Couldn't check ${page.title}`,
              href: page.href,
              tone: "warn",
            });
          return items;
        }),
      );
      return { values, attention: lists.flat() };
    },
  };
}

/** The console's own pages: what the picker, the search and Home read. */
export const CONSOLE_PAGES: ConsolePages = createConsolePages(PAGE_REGISTRY);

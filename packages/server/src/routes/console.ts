/** Page registrations supply Home row values; the shared attention reader supplies concerns. */
import { errorMessage } from "../error-text.js";
import { PAGE_REGISTRY } from "../pages/registry.js";
import type { PageRegistry, Registration } from "../pages/registry.js";
import type { AppConfig } from "../config.js";
import type { MarfaAuth } from "../auth/instance.js";
import { log } from "../middleware/logger.js";
import type { Storage } from "../storage/interface.js";
import type { ConsoleHealth } from "./console-health.js";

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
  /** Present where the server runs housekeeping; Health leaves its value out without it. */
  health?: ConsoleHealth;
  attention?: () => Promise<readonly AttentionItem[]>;
}

export interface ConsoleRegistration extends Registration {
  /** The page's current value, or nothing when it has none worth saying. */
  value?: (reads: ConsoleReads) => Promise<HomeValue | undefined>;
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
  /** Read row values and the shared attention inventory concurrently. */
  read(reads: ConsoleReads): Promise<HomeReading>;
}

/** How long an unbounded console read may hold a response. */
const PROVIDER_DEADLINE_MS = 2000;

const TONES: readonly unknown[] = ["warn", "danger"];

/** Runs `provider` and gives up on it at the deadline. Its timer never outlives it. */
export async function withinDeadline<T>(
  provider: () => Promise<T> | T,
  budgetMs = PROVIDER_DEADLINE_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no answer within ${String(budgetMs)} ms`));
    }, budgetMs);
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

export function createConsolePages(registry: PageRegistry): ConsolePages {
  const providers = new Map<string, ConsoleRegistration["value"]>();
  return {
    registry,
    register(id, { value, ...registration }) {
      registry.register(id, registration);
      providers.set(id, value);
    },
    async read(reads) {
      const attention = reads.attention?.() ?? Promise.resolve([]);
      const values = new Map<string, HomeValue>();
      await Promise.all(
        [...providers].map(async ([id, provider]) => {
          if (!provider) return;
          try {
            const value = await withinDeadline(async () =>
              checkedValue(await provider(reads)),
            );
            if (value) values.set(id, value);
          } catch (error) {
            log("warn", "console: a page could not be read for Home", {
              page: id,
              error: errorMessage(error),
            });
            values.set(id, { text: "Unknown", tone: "warn" });
          }
        }),
      );
      return { values, attention: await attention };
    },
  };
}

/** The console's own pages: what the picker, the search and Home read. */
export const CONSOLE_PAGES: ConsolePages = createConsolePages(PAGE_REGISTRY);

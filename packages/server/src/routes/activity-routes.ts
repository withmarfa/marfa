/**
 * The Activity page of the owner console, read from the audit log the way
 * `GET /audit` reads it and drawn by `activity-pages.tsx`.
 */
import { Hono } from "hono";
import type { AppConfig } from "../config.js";
import * as clock from "../clock.js";
import { readInstanceName } from "../instance-name.js";
import { refuseUndeclaredKeysOf } from "../middleware/undeclared-query-keys.js";
import { requireDirectAuthority, type AppEnv } from "../middleware/auth.js";
import {
  parsePageNumber,
  parsePageSize,
  type Pagination,
} from "../pages/navigation.js";
import { happenedWords } from "../pages/key-time.js";
import { MAX_PAGE_LIMIT } from "../page-limits.js";
import { AUDIT_KINDS, type AuditKind } from "../storage/audit-kinds.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import type { AuditEntry, Storage } from "../storage/interface.js";
import {
  ACTIVITY_HREF,
  WHENS,
  activityHref,
  renderActivityPage,
  type ActivityView,
  type When,
} from "./activity-pages.js";
import { CONSOLE_PAGES } from "./console.js";
import { consoleContentSecurityPolicy } from "./content-security-policy.js";
import { homeSearchQuery } from "./home-page.js";

CONSOLE_PAGES.register("activity", { href: ACTIVITY_HREF });

/** The deepest page the log is walked to, because it is read by cursor and not by offset. */
const MAX_PAGES = 100;

const kindOf = (value: string | undefined): AuditKind | undefined =>
  AUDIT_KINDS.find((kind) => kind === value);

const whenOf = (value: string | undefined): When | undefined =>
  (Object.keys(WHENS) as When[]).find((when) => when === value);

/** One page of the log and whether another follows, found by walking the cursor from the newest. */
async function readPage(
  storage: Storage,
  filter: Parameters<Storage["audit"]["list"]>[0],
  page: number,
  size: number,
): Promise<{ rows: AuditEntry[]; hasNext: boolean }> {
  const skip = (page - 1) * size;
  // One more than the page holds says whether another page follows.
  const want = skip + size + 1;
  const rows: AuditEntry[] = [];
  let cursor: string | undefined;
  while (rows.length < want) {
    const part = await storage.audit.list({
      ...filter,
      limit: Math.min(MAX_PAGE_LIMIT, want - rows.length),
      cursor,
    });
    rows.push(...part.data);
    if (part.next_cursor === null) break;
    cursor = part.next_cursor;
  }
  return {
    rows: rows.slice(skip, skip + size),
    hasNext: rows.length > skip + size,
  };
}

export function activityRoutes(storage: Storage, config: AppConfig) {
  const router = new Hono<AppEnv>();

  router.get("/activity", async (c) => {
    requireDirectAuthority(c);
    refuseUndeclaredKeysOf(c.req.url, ["kind", "when", "q", "page", "size"]);
    const kind = kindOf(c.req.query("kind"));
    const when = whenOf(c.req.query("when"));
    const query = homeSearchQuery(c.req.query("q"));
    const size = parsePageSize(c.req.query("size"));
    const page = Math.min(parsePageNumber(c.req.query("page")), MAX_PAGES);
    const now = clock.nowMs();
    const view: ActivityView = {
      ...(kind && { kind }),
      ...(when && { when }),
      ...(query !== "" && { query }),
      size,
    };
    const { rows, hasNext } = await readPage(
      storage,
      {
        kind,
        q: query === "" ? undefined : query,
        created_after:
          when === undefined
            ? undefined
            : new Date(now - WHENS[when].ms).toISOString(),
      },
      page,
      size,
    );
    // A page past the end of what is left, after the log was trimmed or a
    // filter narrowed, goes back to the first.
    if (rows.length === 0 && page > 1)
      return c.redirect(activityHref({ ...view, page: 1 }));
    const from = (page - 1) * size;
    const pagination: Pagination = {
      page,
      size,
      last: hasNext ? page + 1 : page,
      from,
      to: from + rows.length,
      total: from + rows.length + (hasNext ? 1 : 0),
      hasPrevious: page > 1,
      hasNext: hasNext && page < MAX_PAGES,
    };
    const stored = await readInstanceConfig(storage.settings);
    c.header(
      "Content-Security-Policy",
      consoleContentSecurityPolicy(c.var.cspNonce),
    );
    return c.html(
      renderActivityPage({
        nonce: c.var.cspNonce,
        instanceName: await readInstanceName(storage.settings),
        view,
        rows: rows.map((entry) => ({
          entry,
          ago: happenedWords(Date.parse(entry.created_at), now),
        })),
        pagination,
        generalHref: CONSOLE_PAGES.registry.page("general")?.href,
        retentionDays:
          stored?.audit_retention_days ?? config.auditRetentionDays,
      }),
    );
  });

  return router;
}

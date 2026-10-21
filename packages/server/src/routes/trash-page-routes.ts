import { Hono } from "hono";
import { requireDirectAuthority, type AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { AppConfig } from "../config.js";
import { readInstanceName } from "../instance-name.js";
import {
  parsePageNumber,
  parsePageSize,
  paginate,
} from "../pages/navigation.js";
import { refuseUndeclaredKeysOf } from "../middleware/undeclared-query-keys.js";
import { CONSOLE_PAGES } from "./console.js";
import { consoleContentSecurityPolicy } from "./content-security-policy.js";
import { summaryFilters } from "./item-summaries.js";
import { typePlural } from "./item-pages.js";
import { trashRetention } from "./owner-trash.js";
import { TrashPage } from "./trash-pages.js";
import { homeSearchQuery } from "./home-page.js";
const HREF = "/auth/owner/trash";
CONSOLE_PAGES.register("trash", {
  href: HREF,
  hasItems: true,
  value: async ({ storage }) => {
    const stats = await storage.items.stats({
      ...(await summaryFilters(storage)),
      state: "trashed",
      exclude_system_types: true,
    });
    const n = stats.trashed ?? 0;
    return { text: n ? `${String(n)} items` : "Empty" };
  },
});
export function trashPageRoutes(storage: Storage, config: AppConfig) {
  const router = new Hono<AppEnv>();
  router.get("/trash", async (c) => {
    requireDirectAuthority(c);
    c.header(
      "Content-Security-Policy",
      consoleContentSecurityPolicy(c.var.cspNonce),
    );
    refuseUndeclaredKeysOf(c.req.url, ["type", "q", "page", "size"]);
    return storage.runInReadSnapshot(
      async () => {
        const filters = await summaryFilters(storage);
        const counts = await storage.items.stats(
          { ...filters, state: "trashed", exclude_system_types: true },
          "type",
        );
        const schemas = await storage.types.list();
        const label = (id: string) =>
          typePlural(schemas.find((t) => t.id === id) ?? { id });
        const typeQuery = c.req.query("type");
        const type = typeQuery === "" ? undefined : typeQuery;
        const q = homeSearchQuery(c.req.query("q"));
        const size = parsePageSize(c.req.query("size"));
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        const count = type ? (counts[type] ?? 0) : total;
        const requested = parsePageNumber(c.req.query("page"));
        const page = q ? requested : paginate(count, requested, size).page;
        const result = await storage.items.listTrashSummaries({
          ...filters,
          type,
          q,
          limit: size,
          offset: (page - 1) * size,
        });
        const pagination = q
          ? {
              page,
              size,
              from: (page - 1) * size,
              to: (page - 1) * size + result.data.length,
              total:
                (page - 1) * size +
                result.data.length +
                (result.next_cursor ? 1 : 0),
              last: page + (result.next_cursor ? 1 : 0),
              hasPrevious: page > 1,
              hasNext: result.next_cursor !== null,
            }
          : paginate(count, page, size);
        const href = (at: number) => {
          const params = new URLSearchParams({
            page: String(at),
            size: String(size),
          });
          if (type) params.set("type", type);
          if (q) params.set("q", q);
          return `${HREF}?${params.toString()}`;
        };
        if (q && page > 1 && !result.data.length) return c.redirect(href(1));
        const days = await trashRetention(storage, config);
        return c.html(
          TrashPage({
            nonce: c.var.cspNonce,
            instanceName: await readInstanceName(storage.settings),
            total,
            days,
            type,
            q,
            counts,
            label,
            data: result.data,
            pagination,
            href,
          }),
        );
      },
      { signal: c.req.raw.signal },
    );
  });
  return router;
}

import { Hono, type MiddlewareHandler } from "hono";
import { getTypeSchema, isValidTypeIdentifier } from "@withmarfa/shared";
import { readInstanceName } from "../instance-name.js";
import { requireDirectAuthority, type AppEnv } from "../middleware/auth.js";
import { refuseUndeclaredKeysOf } from "../middleware/undeclared-query-keys.js";
import {
  paginate,
  parsePageNumber,
  parsePageSize,
  type Pagination,
} from "../pages/navigation.js";
import type { ItemSummary, Storage } from "../storage/interface.js";
import { resolveTypeSchema } from "../storage/policy.js";
import { CONSOLE_PAGES } from "./console.js";
import { consoleContentSecurityPolicy } from "./content-security-policy.js";
import { homeSearchQuery } from "./home-page.js";
import {
  ITEMS_HREF,
  itemsHref,
  renderItemsPage,
  renderTypePage,
  typePlural,
  type ItemType,
  type ItemView,
} from "./item-pages.js";
import { isLockedPlatformType } from "./_schema-reach.js";
import { summaryFilters } from "./item-summaries.js";
import { sizeWords } from "./export-routes.js";

async function inventory(storage: Storage) {
  const filters = await summaryFilters(storage);
  const counts = await storage.items.stats(
    { ...filters, exclude_states: ["trashed"], exclude_system_types: true },
    "type",
  );
  const schemas: ItemType["schema"][] = await storage.types.list();
  const registered = new Set(schemas.map((schema) => schema.id));
  for (const id of Object.keys(counts)) {
    if (!registered.has(id)) schemas.push({ id });
  }
  const types: ItemType[] = schemas
    .filter((t) => !t.id.startsWith("system."))
    .map((schema) => ({
      schema,
      count: counts[schema.id] ?? 0,
      plural: typePlural(schema),
    }))
    .sort((a, b) => b.count - a.count || a.plural.localeCompare(b.plural));
  return {
    filters,
    types,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
  };
}
CONSOLE_PAGES.register("items", {
  href: ITEMS_HREF,
  hasItems: true,
  value: async ({ storage }) => {
    const { total } = await inventory(storage);
    return { text: total ? `${String(total)} items` : "None" };
  },
});

export function itemPageRoutes(storage: Storage) {
  const router = new Hono<AppEnv>();
  const gate: MiddlewareHandler<AppEnv> = async (c, next) => {
    requireDirectAuthority(c);
    c.header(
      "Content-Security-Policy",
      consoleContentSecurityPolicy(c.var.cspNonce),
    );
    await storage.runInReadSnapshot(() => next(), { signal: c.req.raw.signal });
  };
  router.get("/items", gate, async (c) => {
    refuseUndeclaredKeysOf(c.req.url, ["type", "q", "page", "size"]);
    const { filters, types, total } = await inventory(storage);
    const rawType = c.req.query("type");
    const type = rawType === "" ? undefined : rawType;
    const query = homeSearchQuery(c.req.query("q"));
    const size = parsePageSize(c.req.query("size"));
    const requestedPage = parsePageNumber(c.req.query("page"));
    const selected = types.find((t) => t.schema.id === type);
    if (type && !selected)
      return c.html(
        renderTypePage({
          nonce: c.var.cspNonce,
          instanceName: await readInstanceName(storage.settings),
          types,
          count: 0,
          trashed: 0,
        }),
        404,
      );
    const view: ItemView = { type, query, size };
    let rows: ItemSummary[] | undefined;
    let pagination: Pagination | undefined;
    const groups: { type: ItemType; rows: ItemSummary[] }[] = [];
    if (type || query) {
      const page = query
        ? requestedPage
        : paginate(selected?.count ?? total, requestedPage, size).page;
      const from = (page - 1) * size;
      const result = await storage.items.listSummaries({
        ...filters,
        type,
        q: query,
        limit: size,
        offset: from,
      });
      rows = result.data;
      if (query && page > 1 && rows.length === 0)
        return c.redirect(itemsHref({ ...view, page: 1 }));
      const hasNext = result.next_cursor !== null;
      pagination = query
        ? {
            page,
            size,
            from,
            to: from + rows.length,
            total: from + rows.length + (hasNext ? 1 : 0),
            last: page + (hasNext ? 1 : 0),
            hasPrevious: page > 1,
            hasNext,
          }
        : paginate(selected?.count ?? total, page, size);
    } else {
      for (const type of types.filter((t) => t.count > 0))
        groups.push({
          type,
          rows: (
            await storage.items.listSummaries({
              ...filters,
              type: type.schema.id,
              limit: 3,
            })
          ).data,
        });
    }
    const blobs = await storage.blobs.count();
    const files = blobs.count
      ? `${String(blobs.count)} files, ${sizeWords(blobs.total_size_bytes)}, in ${String(types.length)} types`
      : `${String(types.length)} types, no files yet`;
    return c.html(
      renderItemsPage({
        nonce: c.var.cspNonce,
        instanceName: await readInstanceName(storage.settings),
        types,
        total,
        files,
        view,
        groups,
        rows,
        pagination,
      }),
    );
  });
  router.get("/types/:id", gate, async (c) => {
    refuseUndeclaredKeysOf(c.req.url, []);
    const { types, filters } = await inventory(storage);
    const id = c.req.param("id");
    const schema =
      isValidTypeIdentifier(id) && !id.startsWith("system.")
        ? resolveTypeSchema(id, getTypeSchema)
        : undefined;
    const trashed = schema
      ? await storage.items.stats(
          { ...filters, state: "trashed", exclude_system_types: true },
          "type",
        )
      : {};
    return c.html(
      renderTypePage({
        nonce: c.var.cspNonce,
        instanceName: await readInstanceName(storage.settings),
        types,
        schema,
        count: types.find((t) => t.schema.id === id)?.count ?? 0,
        trashed: trashed[id] ?? 0,
        removable: !!schema && !isLockedPlatformType(id),
        removalReason:
          schema && !isLockedPlatformType(id)
            ? (await storage.items.countByType(id)) > 0
              ? "This type still has items, including items in the trash. Remove them before removing the type."
              : (await storage.types.list()).some(
                    (t) => t.parent === id || t.compatible_with?.includes(id),
                  )
                ? "Another type depends on this type. Remove that dependency first."
                : undefined
            : undefined,
      }),
      schema ? 200 : 404,
    );
  });
  return router;
}

import { itemName, partName, titleName } from "@withmarfa/shared";
import type { DisplayHints, Edge } from "@withmarfa/shared";
import type { ToolContext } from "../context.js";

/**
 * The effective display hints of each of `types`, from the type itself and
 * its ancestors, as the owner console's names read them. A type the API does
 * not answer for is named without hints.
 */
export async function displayHintsOf(
  ctx: ToolContext,
  types: Iterable<string>,
): Promise<Map<string, DisplayHints | undefined>> {
  const distinct = [...new Set(types)];
  const hints = new Map<string, DisplayHints | undefined>();
  await Promise.all(
    distinct.map(async (id) => {
      const answer = await ctx.api.answer(
        ctx.api.client.GET("/types/{id}", { params: { path: { id } } }),
      );
      hints.set(id, answer.ok ? answer.data.display_hints : undefined);
    }),
  );
  return hints;
}

/** Where an item's name came from: its own fields, or a host's. */
export interface ItemNaming {
  name: string;
  /** Whether the name is a part's, taken from a host. */
  fromHost: boolean;
}

/** Most ids `POST /items/bulk-get` reads in one call. */
const BULK_GET_IDS = 100;

const byAge = (a: Edge, b: Edge): number =>
  a.created_at === b.created_at
    ? a.id < b.id
      ? -1
      : a.id > b.id
        ? 1
        : 0
    : a.created_at < b.created_at
      ? -1
      : 1;

/**
 * Each of `items` named as the owner console names it, from what the caller
 * may read: a part with no nonblank title-like field is named
 * "<edge label> <host name>" after the host of its oldest edge whose type
 * deletes `with-hosts`, among the hosts out of the trash the caller may
 * read. A part in the trash keeps its own name. Only the first page of each edge type an item carries inline is
 * read, so a part with more hosts than that may be named after a later one.
 */
export async function itemNamesOf(
  ctx: ToolContext,
  items: readonly {
    id: string;
    type: string;
    properties: Record<string, unknown>;
  }[],
): Promise<Map<string, ItemNaming>> {
  const hints = await displayHintsOf(
    ctx,
    items.map((item) => item.type),
  );
  const names = new Map<string, ItemNaming>(
    items.map((item) => [
      item.id,
      {
        name: itemName(item.properties, hints.get(item.type)),
        fromHost: false,
      },
    ]),
  );
  const candidates = items.filter(
    (item) => titleName(item.properties, hints.get(item.type)) === undefined,
  );
  if (candidates.length === 0) return names;

  const types = await ctx.api.answer(ctx.api.client.GET("/edge-types"));
  if (!types.ok) return names;
  const labels = new Map(
    types.data.data
      .filter((type) => type.cascade_on_delete === "with-hosts")
      .map((type) => [type.id, type.label]),
  );
  if (labels.size === 0) return names;
  // A part in the trash is not read back here, so it keeps its own name.
  const hostEdges = new Map<string, Edge[]>();
  for (let at = 0; at < candidates.length; at += BULK_GET_IDS) {
    const looked = await ctx.api.answer(
      ctx.api.client.POST("/items/bulk-get", {
        body: {
          ids: candidates.slice(at, at + BULK_GET_IDS).map((item) => item.id),
          include: ["edges"],
        },
      }),
    );
    if (!looked.ok) return names;
    for (const item of looked.data.items) {
      const edges = Object.entries(item.edges ?? {})
        .filter(([type]) => labels.has(type))
        .flatMap(([, block]) => block.data)
        .sort(byAge);
      if (edges.length > 0) hostEdges.set(item.id, edges);
    }
  }
  const hostIds = [
    ...new Set([...hostEdges.values()].flat().map((edge) => edge.target_id)),
  ];
  // `bulk-get` leaves out an item in the trash or one the caller may not
  // read, which is the set a part may not be named after.
  const hosts = new Map<
    string,
    { type: string; properties: Record<string, unknown> }
  >();
  for (let at = 0; at < hostIds.length; at += BULK_GET_IDS) {
    const got = await ctx.api.answer(
      ctx.api.client.POST("/items/bulk-get", {
        body: { ids: hostIds.slice(at, at + BULK_GET_IDS) },
      }),
    );
    if (!got.ok) return names;
    for (const host of got.data.items) hosts.set(host.id, host);
  }
  const hostHints = await displayHintsOf(
    ctx,
    [...hosts.values()].map((host) => host.type),
  );
  for (const [id, edges] of hostEdges) {
    const edge = edges.find((candidate) => hosts.has(candidate.target_id));
    const host = edge && hosts.get(edge.target_id);
    const label = edge && labels.get(edge.edge_type);
    if (!host || label === undefined) continue;
    names.set(id, {
      name: partName(label, itemName(host.properties, hostHints.get(host.type))),
      fromHost: true,
    });
  }
  return names;
}

/** One item's name, as `itemNamesOf` names it. */
export async function itemNameOf(
  ctx: ToolContext,
  item: { id: string; type: string; properties: Record<string, unknown> },
): Promise<string> {
  const named = (await itemNamesOf(ctx, [item])).get(item.id);
  return named?.name ?? "";
}

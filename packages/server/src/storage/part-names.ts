import {
  getEdgeTypeSchema,
  getTypeSchema,
  itemName,
  partName,
  titleName,
} from "@withmarfa/shared";
import type { DisplayHints } from "@withmarfa/shared";
import type { PartHost, Storage } from "./interface.js";
import { resolveTypeSchema } from "./policy.js";

function hintsOf(type: string): DisplayHints | undefined {
  return resolveTypeSchema(type, getTypeSchema)?.display_hints;
}

/** An item's name, and whether it is a part's, taken from a host. */
export interface ItemNaming {
  name: string;
  fromHost: boolean;
}

/**
 * An item's name by `types/item-name-fields`, except that a part with no
 * nonblank title-like field is named "<edge label> <host name>" from the
 * first of `hosts` whose type `mayRead` allows. `hosts` are the part's
 * hosts out of the bin, oldest edge first (`ItemStore.partHosts`). The
 * host's own name is its name by the fields alone, never a part's name, so
 * a reply to a comment is named after the comment's body.
 */
export function namingOf(
  row: { type: string; properties: Record<string, unknown> },
  hosts: readonly PartHost[] | undefined,
  mayRead: (type: string) => boolean,
): ItemNaming {
  const hints = hintsOf(row.type);
  if (hosts !== undefined && titleName(row.properties, hints) === undefined) {
    const named = hosts.find(({ host }) => mayRead(host.type));
    if (named) {
      const label =
        getEdgeTypeSchema(named.edge_type)?.label ?? named.edge_type;
      return {
        name: partName(
          label,
          itemName(named.host.properties, hintsOf(named.host.type)),
        ),
        fromHost: true,
      };
    }
  }
  return { name: itemName(row.properties, hints), fromHost: false };
}

/** An item's name, as `namingOf` names it. */
export function nameOf(
  row: { type: string; properties: Record<string, unknown> },
  hosts: readonly PartHost[] | undefined,
  mayRead: (type: string) => boolean,
): string {
  return namingOf(row, hosts, mayRead).name;
}

/**
 * Each of `items` named by `namingOf` for a caller that may read the types
 * `mayRead` allows, its hosts read in one snapshot.
 */
export async function namingsOf(
  storage: Pick<Storage, "items" | "runInReadSnapshot">,
  items: readonly {
    id: string;
    type: string;
    properties: Record<string, unknown>;
  }[],
  mayRead: (type: string) => boolean,
): Promise<Map<string, ItemNaming>> {
  const hosts = await storage.runInReadSnapshot(() =>
    storage.items.partHosts(items.map((item) => item.id)),
  );
  return new Map(
    items.map((item) => [
      item.id,
      namingOf(item, hosts.get(item.id), mayRead),
    ]),
  );
}

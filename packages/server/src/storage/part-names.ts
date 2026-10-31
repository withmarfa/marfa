import {
  getEdgeTypeSchema,
  getTypeSchema,
  itemName,
  partName,
  titleName,
} from "@withmarfa/shared";
import type { DisplayHints } from "@withmarfa/shared";
import type { PartHost } from "./interface.js";
import { resolveTypeSchema } from "./policy.js";

function hintsOf(type: string): DisplayHints | undefined {
  return resolveTypeSchema(type, getTypeSchema)?.display_hints;
}

/**
 * An item's name by `types/item-name-fields`, except that a part with no
 * nonblank title-like field is named "<edge label> <host name>" from the
 * first of `hosts` whose type `mayRead` allows. `hosts` are the part's
 * hosts out of the bin, oldest edge first (`ItemStore.partHosts`). The
 * host's own name is its name by the fields alone, never a part's name, so
 * a reply to a comment is named after the comment's body.
 */
export function nameOf(
  row: { type: string; properties: Record<string, unknown> },
  hosts: readonly PartHost[] | undefined,
  mayRead: (type: string) => boolean,
): string {
  const hints = hintsOf(row.type);
  if (hosts !== undefined && titleName(row.properties, hints) === undefined) {
    const named = hosts.find(({ host }) => mayRead(host.type));
    if (named) {
      const label =
        getEdgeTypeSchema(named.edge_type)?.label ?? named.edge_type;
      return partName(
        label,
        itemName(named.host.properties, hintsOf(named.host.type)),
      );
    }
  }
  return itemName(row.properties, hints);
}

/**
 * What the doors naming an item by id declare for the two answers the type
 * map decides, worded once so the documents cannot drift apart.
 */

/** The 404: an item of a type the credential may not read answers as none. */
export const ITEM_NOT_FOUND =
  "- `item_not_found`: no item has this ID, or its type is one you can't read.";

/** The 404 of a door that reads only items outside the trash. */
export const ITEM_NOT_FOUND_ON_READ =
  "- `item_not_found`: no item has this ID, the item is in the trash, or its type is one you can't read.";

/** The 404 of a door that writes the item, which a row in the trash meets too. */
export const ITEM_NOT_FOUND_ON_WRITE = `${ITEM_NOT_FOUND} If the item is in the trash and you can read its type, \`details.trashed\` is \`true\`.`;

/** The 403 of a door that reads the item. */
export const READ_REFUSED =
  "- `type_not_permitted`: your credential reaches no type.";

/** The 403 of a door that writes the item. */
export const WRITE_REFUSED =
  "- `type_not_permitted`: you can read the item's type but don't have write on it, or your credential reaches no type. `details.grant` names the missing grant.";

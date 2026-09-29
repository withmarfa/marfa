/**
 * What the doors naming an item by id declare for the two answers the type
 * map decides, worded once so the documents cannot drift apart.
 */

/** The 404: an item of a type the credential may not read answers as none. */
export const ITEM_NOT_FOUND =
  "No item has this id that the credential may read. An item of a type it may not read answers alike, so the answer says nothing of whether one exists.";

/** The 403 of a door that reads the item. */
export const READ_REFUSED =
  "The credential's type permissions reach no type, so there is nothing on the data plane it may read. A credential reaching some types is answered 404 for an item of any other.";

/** The 403 of a door that writes the item. */
export const WRITE_REFUSED =
  "The credential may read the item's type and does not hold write on it, or its type permissions reach no type. An item of a type it may not read answers 404 instead.";

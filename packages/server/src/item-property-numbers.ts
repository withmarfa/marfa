import {
  ErrorCode,
  findInexactIntegers,
  inexactIntegerMessage,
  MarfaError,
} from "@withmarfa/shared";

/**
 * Where a write door carries the properties of an item in its body, as the
 * names of the members and indices that reach them, `*` for any index. A
 * door that writes item properties and is not here keeps `JSON.parse`'s
 * rounding of a whole number (`item-property-numbers.test.ts` holds this
 * list to the published bodies).
 */
export const ITEM_PROPERTY_BAGS: readonly {
  method: string;
  /** The door's path as `openapi.json` spells it. */
  path: string;
  at: readonly string[];
}[] = [
  { method: "POST", path: "/items", at: ["properties"] },
  { method: "PATCH", path: "/items/{id}", at: ["properties"] },
  { method: "POST", path: "/items/bulk", at: ["items", "*", "properties"] },
  { method: "POST", path: "/items/bulk-actions", at: ["patch"] },
  { method: "POST", path: "/folders", at: ["defaults", "properties"] },
  { method: "PATCH", path: "/folders/{id}", at: ["defaults", "properties"] },
];

const DOORS = ITEM_PROPERTY_BAGS.map(({ method, path, at }) => ({
  method,
  path: new RegExp(`^${path.replace(/\{[^}]+\}/g, "[^/]+")}$`),
  at,
}));

/**
 * Refuses a write whose item properties hold a whole number that a 64-bit
 * float cannot hold as written, before the door reads the body. `JSON.parse`
 * rounds such a number, so the door would store a value the caller did not
 * send (`items/property-number-exact`).
 *
 * @param text The request body.
 * @throws MarfaError `invalid_properties`, naming the property.
 */
export function refuseInexactIntegers(
  method: string,
  path: string,
  text: string,
): void {
  const door = DOORS.find(
    (candidate) => candidate.method === method && candidate.path.test(path),
  );
  if (door === undefined) return;
  for (const { source, path: at } of findInexactIntegers(text)) {
    const inside = door.at.every(
      (segment, i) =>
        at[i] !== undefined &&
        (segment === "*" ? /^\d+$/.test(at[i]) : at[i] === segment),
    );
    if (!inside || at.length === door.at.length) continue;
    const field = at.slice(door.at.length).join(".");
    const index = door.at.indexOf("*");
    const message = inexactIntegerMessage(source);
    throw new MarfaError(
      ErrorCode.INVALID_PROPERTIES,
      `Invalid properties: ${field}: ${message}`,
      {
        errors: [{ field, message }],
        ...(index >= 0 && { index: Number(at[index]) }),
      },
    );
  }
}

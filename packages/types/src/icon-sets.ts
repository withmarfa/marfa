import lucide from "../generated/icon-set-lucide.json" with { type: "json" };
import simpleIcons from "../generated/icon-set-simple-icons.json" with { type: "json" };

/** An Iconify icon set a type's icon may come from, at the version Marfa pins. */
export interface IconSet {
  /** The set's Iconify prefix, the part of an icon ID before the colon. */
  prefix: string;
  /** The npm package the set's data comes from. */
  package: string;
  version: string;
  /** Every icon of that version, by name; no alias and no hidden icon. */
  icons: readonly string[];
  /** Each alias of an icon in `icons`, with the icon it resolves to. */
  aliases: Readonly<Record<string, string>>;
}

/** The sets a type's `display_hints.icon` may name an icon from. */
export const ICON_SETS: readonly IconSet[] = [lucide, simpleIcons];

const NAMES: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  ICON_SETS.map((set) => [set.prefix, new Set(set.icons)]),
);

/** Whether `id` is `<prefix>:<name>` for an icon of an accepted set. */
export function isIconId(id: string): boolean {
  const colon = id.indexOf(":");
  if (colon < 0) return false;
  return NAMES.get(id.slice(0, colon))?.has(id.slice(colon + 1)) === true;
}

/**
 * The ID of the Lucide icon a bare `name` stands for: the icon of that name,
 * or the icon Lucide renamed it to. An alias is not itself an accepted ID.
 */
export function lucideIconId(name: string): string | undefined {
  if (NAMES.get("lucide")?.has(name) === true) return `lucide:${name}`;
  const renamed = Object.hasOwn(lucide.aliases, name)
    ? (lucide.aliases as Record<string, string>)[name]
    : undefined;
  return renamed === undefined ? undefined : `lucide:${renamed}`;
}

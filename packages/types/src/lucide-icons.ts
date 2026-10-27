import list from "../generated/lucide-icons.json" with { type: "json" };

/** The Lucide release whose icons a type's `display_hints.icon` may name. */
export const LUCIDE_VERSION: string = list.lucide_version;

/** Every icon of that release, by the kebab-case name Lucide gives it. */
export const LUCIDE_ICON_NAMES: readonly string[] = list.icons;

const NAMES: ReadonlySet<string> = new Set(LUCIDE_ICON_NAMES);

export function isLucideIcon(name: string): boolean {
  return NAMES.has(name);
}

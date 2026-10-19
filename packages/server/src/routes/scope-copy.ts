/**
 * The words the approval screens use for what an app asks for.
 *
 * Both screens name a row from here, so one grant reads the same on either.
 */
import type { ParsedScope } from "@withmarfa/shared";
import { PERMISSION_LABELS } from "./permission-labels.js";
import { oidcLabel } from "./oidc-labels.js";

/**
 * Names for what is not one item type, keyed by pattern, which carries no
 * verb: the level is a control beside the name and never part of it. An item
 * type is named by its own label in the registry, which the approval pages
 * read, so it has no entry here.
 *
 * A name may be shorter than its description but never narrower than its
 * scope, because a grant that sounds smaller than it is makes a person
 * approve more than they think they are approving. A name holds no
 * conjunction: whether the grant reaches types added later is a line the
 * screen composes from `isOpenEnded`.
 */
export const SCOPE_LABELS: Record<string, string> = {
  "user.*": "Your custom types",
  "edge.*": "Links between items",
  profile: "Profile",
  "profile.name": "Name",
  "profile.email": "Email address",
  "profile.avatar": "Avatar",
  metadata: "Definitions on your server",
  "metadata.types": "Custom data types",
  "metadata.edge_types": "Custom relationship types",
  content: "Your content",
};

/**
 * What a name is in the middle of a sentence about a choice, where it reads
 * differently from the name above a control: "your profile" for "Profile".
 * Any other name is that name in lower case.
 */
export const SCOPE_NOUNS: Record<string, string> = {
  profile: "your profile",
  "profile.name": "your name",
  "profile.email": "your email address",
  "profile.avatar": "your avatar",
};

const IRREGULAR_PLURALS: Record<string, string> = {
  person: "people",
  audio: "audio files",
  media: "media",
  series: "series",
  species: "species",
};

/**
 * The plural of a type's label, lower case, for a sentence about a choice:
 * "notes", "people", "summaries". The last word is the one that changes. A
 * label the registry spells in capitals is left as it is written.
 */
export function pluralNoun(label: string): string {
  const words = label.trim().split(/\s+/);
  const last = words.pop() ?? "";
  const lower = last.toLowerCase();
  const irregular = IRREGULAR_PLURALS[lower];
  let plural: string;
  if (irregular !== undefined) plural = irregular;
  else if (/[^aeiou]y$/i.test(last)) plural = `${last.slice(0, -1)}ies`;
  else if (/(s|x|z|ch|sh)$/i.test(last)) plural = `${last}es`;
  else plural = `${last}s`;
  const noun = [...words, plural].join(" ");
  return /^[A-Z]{2}/.test(noun)
    ? noun
    : noun.charAt(0).toLowerCase() + noun.slice(1);
}

/** Title-case the most specific segment of a dotted type pattern, for scopes
 *  outside the curated label map (e.g. a third-party app's custom request). */
export function humanizeType(typePattern: string): string {
  if (typePattern === "*") return "Everything";
  const base = typePattern.replace(/\.\*$/, "");
  const seg = base.split(".").filter(Boolean).pop() ?? base;
  const words = seg.replace(/_/g, " ").trim();
  if (!words) return typePattern;
  const titled = words.charAt(0).toUpperCase() + words.slice(1);
  return typePattern.endsWith(".*") ? `${titled} (all)` : titled;
}

/** What a scope reaches, named for a row's title: no verb, no sentence. */
export function scopeTitle(scope: ParsedScope): string {
  if (scope.kind === "oidc") {
    const literal = scope.oidcScope ?? scope.typePattern;
    return oidcLabel(literal) ?? humanizeType(literal);
  }
  if (scope.kind === "permission" && scope.permission)
    return PERMISSION_LABELS[scope.permission];
  return SCOPE_LABELS[scope.typePattern] ?? humanizeType(scope.typePattern);
}

/** What `profile:write` and its rows permit, since a profile may be changed in part. */
export function profileWriteDescription(
  scope: ParsedScope,
): string | undefined {
  if (scope.kind !== "profile" || scope.operation !== "write") return undefined;
  return scope.profileRow === "name"
    ? "Read and change your name."
    : scope.profileRow === "avatar"
      ? "Read and change your avatar."
      : "Read your name, email address and avatar; change only your name and avatar.";
}

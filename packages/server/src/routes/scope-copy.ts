/**
 * The words the approval screens use for what an app asks for.
 *
 * Both screens name a row from here, so one grant reads the same on either.
 */
import type { ParsedScope } from "@withmarfa/shared";
import { PERMISSION_LABELS } from "./permission-labels.js";
import { oidcLabel } from "./oidc-labels.js";

/**
 * Names keyed by type pattern, which carries no verb: the level is a control
 * beside the name and never part of it.
 *
 * A name may be shorter than its description but never narrower than its
 * scope, because a grant that sounds smaller than it is makes a person
 * approve more than they think they are approving. A bare `core.entity` is
 * exact, so its name says "Organizations" and leaves the people and places
 * to the two types that carry their own rows. A name holds no conjunction:
 * whether the grant reaches types added later is a line the screen composes
 * from `isOpenEnded`.
 */
export const SCOPE_LABELS: Record<string, string> = {
  "core.note": "Notes",
  "core.task": "Tasks",
  "core.bookmark": "Bookmarks",
  "core.highlight": "Highlights",
  "core.event": "Calendar",
  "core.message": "Messages",
  "core.entity": "Organizations",
  "core.entity.person": "Contacts",
  "core.entity.place": "Places",
  "core.file": "Files",
  "core.file.audio": "Audio files",
  "core.file.image": "Images",
  "core.file.video": "Videos",
  "core.media": "Media",
  "core.media.album": "Albums",
  "core.media.article": "Articles",
  "core.media.book": "Books",
  "core.media.episode": "Episodes",
  "core.media.film": "Films",
  "core.media.series": "Series",
  "core.media.song": "Songs",
  "user.*": "Your custom types",
  // "Connections" rather than "Connected accounts", which would narrow the
  // grant to the case that happens to have a login.
  "system.connection": "Connections",
  "system.folder": "Folders",
  profile: "Profile",
  "profile.name": "Name",
  "profile.email": "Email address",
  "profile.avatar": "Avatar",
  metadata: "Definitions on your server",
  "metadata.types": "Custom data types",
  "metadata.edge_types": "Custom relationship types",
  content: "Your content",
};

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

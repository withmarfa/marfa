/**
 * Human names for the permissions, and how the approval screens group them.
 *
 * One home because every surface that names a permission reads it (the
 * approval screens and the Create key page), and a permission
 * whose name differs from one screen to the next is worse than one with no
 * name. Each map is keyed on `Permission`, so adding a permission fails to
 * compile until it has been named: the fallback is `humanizeType`, which
 * would render `webhooks.manage` as "Webhooks", a kind of content, on the
 * screen where a person decides whether to hand over a power.
 */
import type { Permission } from "@withmarfa/shared";
import { isPermission } from "@withmarfa/shared";

/**
 * A full verb phrase, because the row is a power someone hands over, not a
 * category of content. It says everything the permission permits, in words
 * that read the same whoever holds it: an app a person approves, or a key.
 */
export const PERMISSION_LABELS: Record<Permission, string> = {
  "keys.mint": "Make, see, edit and revoke keys",
  "keys.manage": "See, edit, narrow and revoke every key",
  "grants.manage": "See and disconnect other apps",
  "config.manage": "See and change Marfa's settings",
  "instance.read": "See health, metrics, storage and job status",
  "instance.maintain":
    "Run housekeeping, remove retired platform types and cancel bulk jobs",
  "schema.write": "Replace or remove type definitions",
  "blobs.manage": "Read and add any file, and manage file storage",
  "webhooks.manage": "Manage webhooks that send events to other services",
  "connectors.manage": "See, manage and remove all connectors",
  "audit.read": "Read the activity log",
  "items.purge": "Delete items in the trash for good",
};

/** A line under the label, where the label alone leaves out what matters. */
export const PERMISSION_NOTES: Partial<Record<Permission, string>> = {
  "keys.mint": "Keys made this way never hold more than their maker.",
  "keys.manage": "A key's access can be narrowed, never widened.",
  "instance.maintain": "Some jobs permanently delete data that is due to go.",
  "schema.write": "Only for types and relationships with edit access.",
  "webhooks.manage": "Includes seeing webhooks and sending events again.",
  "connectors.manage": "Includes clearing what a connector has saved.",
};

/**
 * The powers that delete data or definitions with no way back: the screens
 * mark them, and say so.
 */
export const DESTRUCTIVE_PERMISSIONS: ReadonlySet<Permission> = new Set([
  "instance.maintain",
  "schema.write",
  "items.purge",
]);

/**
 * The line under a permission's label wherever a person decides whether to
 * grant it: its note, and a mark where it can't be undone. One home, so the
 * approval pages and the key form say the same.
 */
export function permissionDescription(
  permission: Permission,
): string | undefined {
  const note = PERMISSION_NOTES[permission];
  return DESTRUCTIVE_PERMISSIONS.has(permission)
    ? [note, "Can't be undone."].filter(Boolean).join(" ")
    : note;
}

export interface PermissionGroup {
  id: "keys" | "run" | "out";
  title: string;
  description: string;
  permissions: readonly Permission[];
}

/** The three kinds of extra control, in the order the screens list them. */
export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  {
    id: "keys",
    title: "Keys and apps",
    description: "Let it hand out access, or take it away.",
    permissions: ["keys.mint", "keys.manage", "grants.manage"],
  },
  {
    id: "run",
    title: "Running Marfa",
    description: "Let it change how this Marfa runs and what it keeps.",
    permissions: [
      "config.manage",
      "instance.read",
      "instance.maintain",
      "schema.write",
      "blobs.manage",
    ],
  },
  {
    id: "out",
    title: "Connections and records",
    description: "Let it reach outside Marfa, or read and clear its records.",
    permissions: [
      "webhooks.manage",
      "connectors.manage",
      "audit.read",
      "items.purge",
    ],
  },
];

/** The label for a permission literal, or undefined for any other string. */
export function permissionLabel(literal: string): string | undefined {
  return isPermission(literal) ? PERMISSION_LABELS[literal] : undefined;
}

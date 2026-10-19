/**
 * Human names for the permissions, and how the approval screens group them.
 *
 * One home because every surface that names a permission reads it (the
 * approval screens and the key form on the Manage page), and a permission
 * whose name differs from one screen to the next is worse than one with no
 * name. Each map is keyed on `Permission`, so adding a permission fails to
 * compile until it has been named: the fallback is `humanizeType`, which
 * would render `webhooks.manage` as "Webhooks", a kind of content, on the
 * screen where a person decides whether to hand over a power.
 */
import type { Permission } from "@withmarfa/shared";
import { isPermission } from "@withmarfa/shared";

/** A full verb phrase, because the row is a power the person hands over, not a category of content. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  "keys.mint": "Make keys",
  "keys.manage": "See, narrow and revoke every key",
  "grants.manage": "See and disconnect your other apps",
  "config.manage": "Change Marfa's settings",
  "instance.read": "See health and storage reports",
  "instance.maintain": "Run housekeeping",
  "schema.write": "Change or remove the types it can edit",
  "blobs.manage": "Read all files and manage where they're kept",
  "webhooks.manage": "Send your data to other services",
  "connectors.manage": "Manage all connectors",
  "audit.read": "Read the activity log",
  "items.purge": "Delete items in the trash for good",
};

/** A line under the label, where the label alone leaves out what matters. */
export const PERMISSION_NOTES: Partial<Record<Permission, string>> = {
  "keys.mint": "Each key it makes holds no more than it holds itself.",
  "instance.maintain": "Some jobs delete data that is due to go.",
  "webhooks.manage": "Using webhooks.",
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

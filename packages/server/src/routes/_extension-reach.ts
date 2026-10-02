/**
 * The one way an item's extension data reaches a credential.
 *
 * **A credential is answered the namespaces its extension map lets it read,
 * and its own label's, on every door that answers extension data, whatever
 * the door did to get there.** A write door is not a read of what it did not
 * write: a key that may write one namespace answered with the whole map
 * would read every other integration's data off its own write. The export
 * is not exempt either, because it is a read of the same rows.
 *
 * There is no privileged reader. The operator key holds no type map, so it
 * reaches none of the doors that answer item data at all.
 *
 * Every door that answers a metadata row or an extensions map passes it
 * through here; `extension-door-census.test.ts` finds those doors in the
 * OpenAPI document and drives each with a key holding one namespace.
 */
import { extensionLabelOf } from "../auth/extension-label.js";
import { filterExtensionsByPermission } from "@withmarfa/shared";
import type { ApiKey, Metadata } from "@withmarfa/shared";

/** The credential fields the rule reads. */
export type ExtensionReader = Pick<
  ApiKey,
  "extension_permissions" | "label" | "oauth_client_id"
>;

/** The namespaces of `extensions` that `reader` may read. */
export function readableExtensions(
  extensions: Record<string, Record<string, unknown>>,
  reader: ExtensionReader | undefined,
): Record<string, Record<string, unknown>> {
  return filterExtensionsByPermission(
    extensions,
    reader?.extension_permissions,
    extensionLabelOf(reader),
  );
}

/** A metadata row with its extensions narrowed to what `reader` may read. */
export function readableMetadata(
  metadata: Metadata,
  reader: ExtensionReader | undefined,
): Metadata {
  return {
    ...metadata,
    extensions: readableExtensions(metadata.extensions, reader),
  };
}

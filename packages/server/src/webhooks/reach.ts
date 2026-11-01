/**
 * What a webhook delivery may carry: the event as the credential that
 * registered the subscription may read it, asked when the delivery is sent.
 *
 * **A subscription belongs to the credential that registered it, and a
 * delivery is a read made for that credential.** So it is answered by the
 * questions every read door asks: an item event only where the item's type
 * is readable and the credential's source filter shows it, with a cascade's
 * marks naming a row only where that row's type is, and extension namespaces
 * only where the extension map reaches them; an edge event only where the
 * single edge read would answer it and the source filter shows its source
 * item. The credential and its source filter are read as they stand at the
 * attempt, so one narrowed after the event narrows what is sent, and a retry
 * is asked again.
 *
 * Every send goes through `deliveryInReach` in `delivery.ts`, which asks this;
 * `delivery-census.test.ts` holds that.
 */
import { resolveEnforcement } from "@withmarfa/shared";
import type { ApiKey, Edge, Metadata } from "@withmarfa/shared";
import type { LiveCredential } from "../auth/live-credential.js";
import { mayReadType } from "../middleware/auth.js";
import { frameFor } from "../pubsub.js";
import {
  announcedEdgeSourceShown,
  edgeKindReadable,
} from "../routes/_edge-visibility.js";
import { readableMetadata } from "../routes/_extension-reach.js";
import {
  sourceFilterIncludesItem,
  type SourceFilterSettings,
} from "../storage/filter-sql.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import type { ReadOnlyItems, Storage } from "../storage/interface.js";

/** What a subscription's credential may be sent, as it stands now. */
export interface DeliveryReach {
  key: ApiKey;
  sourceFilter: SourceFilterSettings | undefined;
}

/** The reach of a credential that still stands, with the source filter that
 *  holds for it now, its own override's or the instance's. */
export async function deliveryReach(
  storage: Storage,
  credential: LiveCredential,
): Promise<DeliveryReach> {
  return {
    key: credential.key,
    sourceFilter: resolveEnforcement(
      await readInstanceConfig(storage.settings),
      credential.key,
    ).source_filter,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The frame `key` may be sent for this stored frame, or null where it may
 * be sent none. The stored frame is what a reader of everything is sent,
 * with the types its marks name, as `storedFrame` in `pubsub.ts` builds it.
 * An item frame carries `read_only` as `readOnly` says; a caller asking only
 * whether a frame may be sent passes null and loads no registrations.
 */
export function frameInReach(
  { key, sourceFilter }: DeliveryReach,
  stored: Record<string, unknown>,
  readOnly: ReadOnlyItems | null,
): Record<string, unknown> | null {
  if (isRecord(stored.edge)) {
    const edge = stored.edge as unknown as Edge;
    if (typeof edge.edge_type !== "string") return null;
    if (!edgeKindReadable(key, edge)) return null;
    // The source's type when the event was published, and only that, as the
    // stream asks it: a purge takes the source row, and a retype after the
    // event changes nothing about who may be told of it.
    if (
      typeof stored.source_type !== "string" ||
      !mayReadType(key, stored.source_type)
    ) {
      return null;
    }
    const sourceItemSource = stored.source_item_source;
    if (
      !announcedEdgeSourceShown(
        sourceFilter,
        stored.source_type,
        typeof sourceItemSource === "string" ? sourceItemSource : undefined,
      )
    ) {
      return null;
    }
    return frameFor(stored, (type) => mayReadType(key, type));
  }
  const item = stored.item;
  if (!isRecord(item) || typeof item.type !== "string") return null;
  if (!mayReadType(key, item.type)) return null;
  if (
    !sourceFilterIncludesItem(sourceFilter, {
      type: item.type,
      source: item.source,
    })
  ) {
    return null;
  }
  const frame = frameFor(
    stored,
    (type) => mayReadType(key, type),
    readOnly ?? undefined,
  );
  const metadata = frame.metadata;
  if (!isRecord(metadata)) return frame;
  return {
    ...frame,
    metadata: readableMetadata(
      {
        ...(metadata as unknown as Metadata),
        extensions: isRecord(metadata.extensions)
          ? (metadata.extensions as Metadata["extensions"])
          : {},
      },
      key,
    ),
  };
}

/**
 * What a webhook delivery may carry: the event as the credential that
 * registered the subscription may read it, asked when the delivery is sent.
 *
 * **A subscription belongs to the credential that registered it, and a
 * delivery is a read made for that credential.** So it is answered by the
 * questions every read door asks: an item event only where the item's type
 * is readable, with a cascade's marks naming a row only where that row's
 * type is, and extension namespaces only where the extension map reaches
 * them; an edge event only where the single edge read would answer it. The
 * credential is read as it stands at the attempt, so one narrowed after the
 * event narrows what is sent, and a retry is asked again.
 *
 * Every send goes through `deliveryInReach` in `delivery.ts`, which asks this;
 * `delivery-census.test.ts` holds that.
 */
import type { ApiKey, Edge, Metadata } from "@withmarfa/shared";
import { mayReadType } from "../middleware/auth.js";
import { frameFor } from "../pubsub.js";
import { edgeKindReadable, edgeReadable } from "../routes/_edge-visibility.js";
import { readableMetadata } from "../routes/_extension-reach.js";
import type { Storage } from "../storage/interface.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The frame `key` may be sent for this stored frame, or null where it may
 * be sent none. The stored frame is what a reader of everything is sent,
 * with the types its marks name, as `storedFrame` in `pubsub.ts` builds it.
 */
export async function frameInReach(
  storage: Storage,
  key: ApiKey,
  stored: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (isRecord(stored.edge)) {
    const edge = stored.edge as unknown as Edge;
    if (typeof edge.edge_type !== "string") return null;
    if (!edgeKindReadable(key, edge)) return null;
    // The source's type when the event was published, as the stream asks
    // it: a purge takes the source row, and a missing row reads as no type.
    if (
      typeof stored.source_type !== "string" ||
      !mayReadType(key, stored.source_type)
    ) {
      return null;
    }
    if (!(await edgeReadable(storage, key, edge))) return null;
    return { ...stored };
  }
  const item = stored.item;
  if (!isRecord(item) || typeof item.type !== "string") return null;
  if (!mayReadType(key, item.type)) return null;
  const frame = frameFor(stored, (type) => mayReadType(key, type));
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

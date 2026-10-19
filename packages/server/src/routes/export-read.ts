import type { Edge } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import type { OwnerItemRead } from "./_owner-item-read.js";

/** Read inside the edge page's snapshot: exported IDs record earlier reach. */
export async function readableExportEdges(
  storage: Storage,
  reader: OwnerItemRead,
  edges: Edge[],
): Promise<Edge[]> {
  const readable = edges.filter((edge) => reader.edge(edge));
  if (reader.owner || readable.length === 0) return readable;
  const sources = await storage.items.getMany(
    [...new Set(readable.map((edge) => edge.source_id))],
    { includeTrashed: true },
  );
  return readable.filter((edge) => {
    const source = sources.get(edge.source_id);
    return source !== undefined && reader.reads(source.type);
  });
}

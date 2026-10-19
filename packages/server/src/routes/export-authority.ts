/**
 * What an export answers to while it streams.
 *
 * An export reads for as long as its client reads, so the credential it was
 * admitted on can end or narrow under it. Before each batch it sends and
 * each blob it streams, it asks the credential again, as the next request
 * on that credential would be asked, and sends nothing the credential does
 * not read now. The response then ends with an error, never a clean end,
 * because an export that stopped short must not look like one that finished.
 *
 * A credential that narrows but still reads everything the export carries
 * leaves it running. One that no longer reads something the export carries
 * ends it rather than skipping the row: a skipped row would leave a copy
 * incomplete without saying so, and an archive has already promised its rows
 * and blobs in the manifest.
 */

import { isDeepStrictEqual } from "node:util";
import {
  MarfaError,
  resolveEnforcement,
  type Edge,
  type Item,
  type Metadata,
} from "@withmarfa/shared";
import type { Context } from "hono";
import { recheckRequestAuthority } from "../auth/request-authority.js";
import type { AppEnv } from "../middleware/auth.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import type { Storage } from "../storage/interface.js";
import {
  sourceFilterIncludesItem,
  type SourceFilterSettings,
} from "../storage/filter-sql.js";
import { ownerItemRead, type OwnerItemRead } from "./_owner-item-read.js";

/** An export that stopped because its credential ended or narrowed. */
export class ExportCredentialEnded extends Error {
  constructor(
    readonly reason: "credential_ended" | "credential_narrowed",
    options: { cause?: unknown } = {},
  ) {
    super(
      reason === "credential_ended"
        ? "The export's credential ended"
        : "The export's credential no longer reads what the export carries",
      options,
    );
    this.name = "ExportCredentialEnded";
  }
}

/** The credential as it stands now. */
interface ExportView {
  reader: OwnerItemRead;
  sourceFilter: SourceFilterSettings | undefined;
}

/** One item as an export carries it: the row, its metadata, its history. */
export interface CarriedRow {
  item: Item;
  metadata: Metadata;
  versions?: readonly Item[];
}

export interface ExportAuthority {
  /**
   * The credential as it stands now. Refuses with the error a new request on
   * the credential would get, so before the response starts it answers with
   * that status.
   */
  current(): Promise<ExportView>;
  /** Throws `ExportCredentialEnded` unless the credential stands. */
  standing(): Promise<void>;
  /** Throws `ExportCredentialEnded` unless the credential reads every row. */
  rows(rows: readonly CarriedRow[]): Promise<void>;
  /** Throws `ExportCredentialEnded` unless the credential reads every edge. */
  edges(edges: readonly Edge[]): Promise<void>;
  /** Throws `ExportCredentialEnded` unless the credential reads the blob. */
  blob(hash: string): Promise<void>;
}

/**
 * Holds the authority the request was admitted on, to ask again while the
 * export runs. Call it from the route handler, inside the request.
 */
export function holdExportAuthority(
  c: Context<AppEnv>,
  storage: Storage,
): ExportAuthority {
  const recheck = recheckRequestAuthority();
  const admitted = ownerItemRead(c);

  const current = async (): Promise<ExportView> => {
    await recheck();
    const reader = ownerItemRead(c);
    const { source_filter: sourceFilter } = resolveEnforcement(
      await readInstanceConfig(storage.settings),
      c.get("apiKey"),
    );
    return { reader, sourceFilter };
  };

  /** A refusal a new request would get is the credential ending. */
  const view = async (): Promise<ExportView> => {
    try {
      return await current();
    } catch (error) {
      if (error instanceof MarfaError)
        throw new ExportCredentialEnded("credential_ended", { cause: error });
      throw error;
    }
  };

  const narrowed = (): ExportCredentialEnded =>
    new ExportCredentialEnded("credential_narrowed");

  /** Whether JSON carries the same value, whatever its key order. */
  const same = (a: unknown, b: unknown): boolean =>
    isDeepStrictEqual(
      JSON.parse(JSON.stringify(a)) as unknown,
      JSON.parse(JSON.stringify(b)) as unknown,
    );

  return {
    current,
    async standing() {
      await view();
    },
    async rows(rows) {
      const { reader, sourceFilter } = await view();
      for (const { item, metadata, versions } of rows) {
        if (
          !reader.reads(item.type) ||
          !sourceFilterIncludesItem(sourceFilter, item) ||
          !(versions ?? []).every((version) => reader.reads(version.type)) ||
          !same(reader.metadata(metadata), metadata)
        )
          throw narrowed();
      }
      // A row a cascade binned names its root only to a credential that
      // reads the root's type. A root purged since is no change in reach.
      const named = new Set(
        rows.flatMap(({ item }) => {
          const root = (item as { trashed_with?: unknown }).trashed_with;
          return typeof root === "string" ? [root] : [];
        }),
      );
      if (named.size === 0) return;
      const roots = await storage.items.getMany([...named], {
        includeTrashed: true,
      });
      for (const root of roots.values())
        if (!reader.reads(root.type)) throw narrowed();
    },
    async edges(edges) {
      const { reader, sourceFilter } = await view();
      if (edges.length === 0) return;
      // A source that is gone since the edge was read is no change to what
      // the credential reads, so it does not end the export.
      const sources = await storage.items.getMany(
        [...new Set(edges.map((edge) => edge.source_id))],
        { includeTrashed: true },
      );
      for (const edge of edges) {
        const source = sources.get(edge.source_id);
        if (
          !reader.edge(edge) ||
          (source &&
            !(
              reader.reads(source.type) &&
              sourceFilterIncludesItem(sourceFilter, source)
            ))
        )
          throw narrowed();
      }
    },
    async blob(hash) {
      const { reader } = await view();
      // A write since the selection was read may have stopped the row from
      // lending this blob, which is no change to what the credential reads:
      // only a credential that reads less than it did ends the export.
      if (
        (await admitted.blob(storage, hash)) &&
        !(await reader.blob(storage, hash))
      )
        throw narrowed();
    },
  };
}

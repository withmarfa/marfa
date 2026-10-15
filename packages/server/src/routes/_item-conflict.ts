import { z } from "@hono/zod-openapi";
import { REFUSAL_TEXT } from "../openapi.js";
import {
  AT_THIS_VERSION,
  TierEnum,
  VersionConflictErrorSchema,
} from "./_schemas.js";

export const ConflictSnapshotSchema = z
  .object({
    // The row, because a create names a natural key and not an id: refused
    // here, it learns which row the key resolved from this and nothing else.
    id: z.string().describe("The ID of the item."),
    version: z.number().describe("The item version this side shows."),
    properties: z
      .record(z.string(), z.unknown())
      .describe(AT_THIS_VERSION.properties),
    // The version check covers these three beside the properties, so a
    // collision can name one; without them here the refusal names a field
    // the caller has no way to read either side of.
    tier: TierEnum.describe(AT_THIS_VERSION.tier),
    occurred_at: z.string().describe(AT_THIS_VERSION.occurred_at),
    source_id: z.string().nullable().describe(AT_THIS_VERSION.source_id),
    // And the type, because a stale move onto a row moved since collides
    // on it: the refusal shows the type the row has and the one the
    // caller read.
    type: z.string().describe("The item's type identifier at this version."),
  })
  .describe("An item as it stood at one version, as a conflict shows it.")
  .openapi("ConflictSnapshot");

/** The two sides of a conflict, worded once for every conflict answer. */
export const CONFLICT_SIDES = {
  error: REFUSAL_TEXT.error,
  current: "The item as it stands now.",
  ancestor: "The item at the `version` you sent.",
} as const;

/**
 * The refusal for a failed exact version precondition.
 *
 * `current` and `error.status` are here because every `version_conflict`
 * carries them, whichever door answered and whatever the write held. What is
 * absent is what a merge would need: this refusal attempts no merge.
 */
export const StaleVersionSchema = z
  .object({
    error: VersionConflictErrorSchema.describe(CONFLICT_SIDES.error),
    current: ConflictSnapshotSchema.describe(CONFLICT_SIDES.current),
  })
  .describe("A failed exact version precondition: the error and the item now.")
  .openapi("ItemStaleVersion");

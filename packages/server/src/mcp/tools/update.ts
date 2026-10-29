import { isDeepStrictEqual } from "node:util";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { components } from "@withmarfa/client";
import { itemId, pathSegment } from "../args.js";
import * as z from "zod";
import type { ApiAnswer, ApiRefusal } from "../api.js";
import type { ToolContext } from "../context.js";
import { fail, ok, refused } from "../results.js";

const edgeRef = z.strictObject({
  edge_type: z.string().min(1),
  target_id: itemId,
});

const outputSchema = z.object({
  id: z.string(),
  version: z.number(),
  state: z.string(),
  applied: z.array(z.string()),
});

interface ItemAnswer {
  item: CurrentItem;
}

interface CurrentItem {
  id: string;
  version: number;
  state: string;
  properties?: Record<string, unknown>;
  tier?: string;
  occurred_at?: string;
}

/** The arguments a stale answer weighs: the fields the call would set. */
interface FieldArgs {
  version: number;
  properties?: Record<string, unknown> | undefined;
  properties_mode?: "merge" | "replace" | undefined;
  tier?: string | undefined;
  occurred_at?: string | undefined;
}

/** How many pages of an item's history a stale answer reads for its base. */
const HISTORY_PAGES = 10;
const HISTORY_PAGE_SIZE = 200;

/**
 * The refusal of a call whose version is not the item's: the item now, and
 * which of the fields the call would set were also changed by a write since
 * the version it read. Nothing is written.
 */
async function staleAnswer(
  ctx: ToolContext,
  args: FieldArgs,
  current: CurrentItem,
): Promise<CallToolResult> {
  const base = await snapshotAt(ctx, current.id, args.version);
  const answer = {
    code: "version_conflict",
    message: `The item is at version ${String(current.version)}, not ${String(args.version)}. Nothing was changed.`,
    hint: "Read the item again with marfa_get, decide whether your change still applies, and send the version you read.",
    current,
  };
  if (base === null) {
    return fail({
      ...answer,
      note: `Marfa holds no snapshot of version ${String(args.version)} that this credential can read, so which fields changed since is not known.`,
    });
  }
  return fail({
    ...answer,
    conflicting_fields: conflictingFields(args, base, current),
  });
}

/** The item as it was at `version`, from its history, or null. */
async function snapshotAt(
  ctx: ToolContext,
  id: string,
  version: number,
): Promise<Snapshot | null> {
  let cursor: string | undefined;
  for (let page = 0; page < HISTORY_PAGES; page++) {
    const answer = await ctx.api.answer(
      ctx.api.client.GET("/items/{id}/versions", {
        params: {
          path: { id },
          query: { limit: HISTORY_PAGE_SIZE, ...(cursor && { cursor }) },
        },
      }),
    );
    if (!answer.ok) return null;
    const found = answer.data.data.find((v) => v.version === version);
    if (found !== undefined) return found;
    if (answer.data.data.some((v) => v.version > version)) return null;
    if (answer.data.next_cursor === null) return null;
    cursor = answer.data.next_cursor;
  }
  return null;
}

type Snapshot = Pick<
  components["schemas"]["Version"],
  "properties" | "tier" | "occurred_at"
>;

/**
 * The fields the call would change that a write since `base` changed too,
 * on the API's own rule: a field sent at the value it had at `base` is not
 * a change, and a field `replace` leaves out is cleared, which is.
 */
function conflictingFields(
  args: FieldArgs,
  base: Snapshot,
  current: CurrentItem,
): string[] {
  const before = base.properties;
  const now = current.properties ?? {};
  const sent = args.properties ?? {};
  const changed = new Set(
    Object.keys(sent).filter(
      (key) => !isDeepStrictEqual(sent[key], before[key]),
    ),
  );
  if (args.properties_mode === "replace") {
    for (const key of Object.keys(before)) {
      if (!Object.hasOwn(sent, key)) changed.add(key);
    }
  }
  const fields = [...changed].filter(
    (key) => !isDeepStrictEqual(now[key], before[key]),
  );
  if (
    args.tier !== undefined &&
    args.tier !== base.tier &&
    current.tier !== base.tier
  ) {
    fields.push("tier");
  }
  if (
    args.occurred_at !== undefined &&
    !sameTime(args.occurred_at, base.occurred_at) &&
    !sameTime(current.occurred_at, base.occurred_at)
  ) {
    fields.push("occurred_at");
  }
  return fields.sort();
}

function sameTime(a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const left = Date.parse(a);
  return !Number.isNaN(left) && left === Date.parse(b);
}

/** What a stale or colliding write carries, kept for the agent to decide on. */
function conflictExtra(refusal: ApiRefusal): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const key of ["current", "conflicting_fields"]) {
    if (refusal.body[key] !== undefined) extra[key] = refusal.body[key];
  }
  return extra;
}

export function registerUpdate(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "marfa_update",
    {
      title: "Change an item",
      description:
        "Use to change an existing note, task, record or other item: its fields, tags, edges, or whether it is archived, or to restore it from the trash. Send the version you read with marfa_get; if the item has changed since, nothing is written and you get it as it is now and which of your fields changed.",
      inputSchema: z.strictObject({
        id: itemId.describe("The item's ID."),
        version: z
          .number()
          .int()
          .min(1)
          .describe(
            "The item's version, as you last read it. Moving an item to the trash keeps its version.",
          ),
        properties: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Fields to set. Fields you leave out keep their values, unless properties_mode is `replace`.",
          ),
        properties_mode: z
          .enum(["merge", "replace"])
          .optional()
          .describe(
            "`replace` makes properties the item's whole set of fields; `merge` when left out.",
          ),
        tier: z.enum(["library", "feed"]).optional(),
        occurred_at: z
          .string()
          .optional()
          .describe("The item's own time (RFC 3339)."),
        add_tags: z.array(z.string().min(1)).optional(),
        remove_tags: z.array(pathSegment).optional(),
        add_edges: z
          .array(edgeRef)
          .optional()
          .describe("Edges to add from this item."),
        remove_edges: z
          .array(edgeRef)
          .optional()
          .describe("Edges to remove from this item."),
        state: z
          .enum(["active", "archived"])
          .optional()
          .describe(
            "`archived` to archive the item; `active` to bring it back from the archive or the trash. An item in the trash takes no other change until it is restored.",
          ),
      }),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const { api } = ctx;
      const id = args.id;
      const applied: string[] = [];

      const read = await api.answer(
        api.client.GET("/items/{id}", { params: { path: { id } } }),
      );
      if (!read.ok) {
        // The API reads no trashed item by ID, so a trashed item is restored
        // by a transition that names the version: a move to the trash keeps
        // the version, and the transition moves nothing if it differs.
        if (read.refusal.status === 404 && restoreOnly(args)) {
          const restored = await api.answer(
            api.client.POST("/items/{id}/transition", {
              params: { path: { id }, query: { version: args.version } },
              body: { state: "active" },
            }),
          );
          if (!restored.ok) {
            return refused(restored.refusal, conflictExtra(restored.refusal));
          }
          const item = (restored.data as unknown as ItemAnswer).item;
          return ok({
            id,
            version: item.version,
            state: item.state,
            applied: ["state active"],
          });
        }
        return refused(read.refusal);
      }
      const current = (read.data as unknown as ItemAnswer).item;
      if (current.version !== args.version) {
        return staleAnswer(ctx, args, current);
      }
      // Every write names the version: the read's, or the one the write
      // before it left. An edge write leaves the item's version as it was,
      // so a change landing after one is refused by the next write.
      let { version, state } = current;
      const patching =
        args.properties !== undefined ||
        args.tier !== undefined ||
        args.occurred_at !== undefined;

      /** Stop at a failed step, saying what was already applied. */
      const stop = (step: string, refusal: ApiRefusal) =>
        refused(refusal, {
          failed_step: step,
          applied,
          ...conflictExtra(refusal),
          ...(applied.length > 0 && {
            note: "The steps in applied were written before this one failed.",
          }),
        });

      if (patching) {
        const patched = await api.answer(
          api.client.PATCH("/items/{id}", {
            params: { path: { id } },
            body: {
              version,
              version_match: "exact",
              ...(args.properties !== undefined && {
                properties: args.properties,
              }),
              ...(args.properties_mode !== undefined && {
                properties_mode: args.properties_mode,
              }),
              ...(args.tier !== undefined && { tier: args.tier }),
              ...(args.occurred_at !== undefined && {
                occurred_at: args.occurred_at,
              }),
            },
          }),
        );
        if (!patched.ok) return stop("properties", patched.refusal);
        ({ version, state } = (patched.data as unknown as ItemAnswer).item);
        applied.push("properties");
      }

      for (const edge of args.add_edges ?? []) {
        const added = await api.answer(
          api.client.POST("/edges", {
            params: { query: { source_version: version } },
            body: {
              source_id: id,
              target_id: edge.target_id,
              edge_type: edge.edge_type,
            },
          }),
        );
        if (!added.ok) return stop(`add_edge ${edge.edge_type}`, added.refusal);
        applied.push(`add_edge ${edge.edge_type} ${edge.target_id}`);
      }

      for (const edge of args.remove_edges ?? []) {
        const found = await findEdge(ctx, id, edge.edge_type, edge.target_id);
        if (!found.ok)
          return stop(`remove_edge ${edge.edge_type}`, found.refusal);
        if (found.data === null) {
          return stop(`remove_edge ${edge.edge_type}`, {
            status: 404,
            code: "edge_not_found",
            message: `The item has no ${edge.edge_type} edge to ${edge.target_id}.`,
            body: {},
          });
        }
        const removed = await api.answer(
          api.client.DELETE("/edges/{id}", {
            params: {
              path: { id: found.data },
              query: { source_version: version },
            },
          }),
        );
        if (!removed.ok) {
          return stop(`remove_edge ${edge.edge_type}`, removed.refusal);
        }
        applied.push(`remove_edge ${edge.edge_type} ${edge.target_id}`);
      }

      if (args.state !== undefined && args.state !== state) {
        const moved = await api.answer(
          api.client.POST("/items/{id}/transition", {
            params: { path: { id }, query: { version } },
            body: { state: args.state },
          }),
        );
        if (!moved.ok) return stop(`state ${args.state}`, moved.refusal);
        ({ version, state } = (moved.data as unknown as ItemAnswer).item);
        applied.push(`state ${args.state}`);
      }

      if (args.add_tags !== undefined && args.add_tags.length > 0) {
        const tagged = await api.answer(
          api.client.POST("/items/{id}/tags", {
            params: { path: { id }, query: { version } },
            body: { tags: args.add_tags },
          }),
        );
        if (!tagged.ok) return stop("add_tags", tagged.refusal);
        applied.push("add_tags");
      }
      for (const tag of args.remove_tags ?? []) {
        const untagged = await api.answer(
          api.client.DELETE("/items/{id}/tags/{tag}", {
            params: { path: { id, tag }, query: { version } },
          }),
        );
        if (!untagged.ok) return stop(`remove_tag ${tag}`, untagged.refusal);
        applied.push(`remove_tag ${tag}`);
      }

      if (applied.length === 0) {
        return fail({
          code: "validation_error",
          message: "Nothing to change: name at least one change.",
        });
      }
      return ok({ id, version, state, applied });
    },
  );
}

/** Whether the call asks only to bring the item back to `active`. */
function restoreOnly(args: Record<string, unknown>): boolean {
  return (
    args.state === "active" &&
    Object.entries(args).every(
      ([key, value]) =>
        value === undefined || ["id", "version", "state"].includes(key),
    )
  );
}

/** The ID of the item's `edgeType` edge to `targetId`, or null. */
async function findEdge(
  ctx: ToolContext,
  id: string,
  edgeType: string,
  targetId: string,
): Promise<ApiAnswer<string | null>> {
  let cursor: string | undefined;
  for (;;) {
    const page = await ctx.api.answer(
      ctx.api.client.GET("/items/{id}/edges", {
        params: {
          path: { id },
          query: { edge_type: edgeType, limit: 500, cursor },
        },
      }),
    );
    if (!page.ok) return page;
    const edge = page.data.data.find((e) => e.target_id === targetId);
    if (edge !== undefined) return { ok: true, status: 200, data: edge.id };
    if (page.data.next_cursor === null) {
      return { ok: true, status: 200, data: null };
    }
    cursor = page.data.next_cursor;
  }
}

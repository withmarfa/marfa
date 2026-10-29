import type { McpServer } from "@modelcontextprotocol/server";
import type { components } from "@withmarfa/client";
import * as z from "zod";
import type { ApiRefusal } from "../api.js";
import { holdsAny, type ToolContext } from "../context.js";
import { ANSWER_BUDGET_CHARS, fitList, ok, refused } from "../results.js";

type Connector = components["schemas"]["Connector"];

const healthOutput = z.object({
  health: z.looseObject({ status: z.string() }),
  metrics: z.looseObject({}).optional(),
  connectors: z.array(z.looseObject({ id: z.string() })).optional(),
  connectors_left_out: z
    .boolean()
    .optional()
    .describe("`true` when there are more connectors than this answer holds."),
  unread: z
    .array(
      z.object({ read: z.string(), code: z.string(), message: z.string() }),
    )
    .optional()
    .describe("Each part that could not be read, with the API's error."),
});

function unreadOf(read: string, refusal: ApiRefusal) {
  return { read, code: refusal.code, message: refusal.message };
}

function connectorState(connector: Connector) {
  return {
    id: connector.id,
    name: connector.name,
    source: connector.source,
    last_heartbeat_at: connector.last_heartbeat_at,
    last_run: connector.last_run,
    problems: connector.problems,
    hold_expires_at: connector.hold_expires_at,
  };
}

export function registerHealth(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "marfa_health",
    {
      title: "How this Marfa is doing",
      description:
        "Use to check this Marfa: whether it is serving and each component's state, its counts of items, files, keys and webhooks, and each connector's last run and problems.",
      inputSchema: z.strictObject({}),
      outputSchema: healthOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const healthAnswer = await ctx.api.answer(ctx.api.client.GET("/health"));
      let health: Record<string, unknown>;
      if (healthAnswer.ok) {
        health = healthAnswer.data;
      } else if (
        healthAnswer.refusal.status === 503 &&
        typeof healthAnswer.refusal.body.components === "object"
      ) {
        // A down instance answers 503 with the same body.
        health = healthAnswer.refusal.body;
      } else {
        return refused(healthAnswer.refusal);
      }

      // A read that is refused leaves the others standing: a down
      // instance is when the health matters most.
      const unread: { read: string; code: string; message: string }[] = [];
      let metrics: Record<string, unknown> | undefined;
      if (holdsAny(ctx, "instance.read")) {
        const answer = await ctx.api.answer(ctx.api.client.GET("/metrics"));
        if (answer.ok) metrics = answer.data;
        else unread.push(unreadOf("metrics", answer.refusal));
      }

      const connectors = await ctx.api.answer(
        ctx.api.client.GET("/connectors"),
      );
      if (!connectors.ok)
        unread.push(unreadOf("connectors", connectors.refusal));
      const fitted = fitList(
        connectors.ok ? connectors.data.data.map(connectorState) : [],
        ANSWER_BUDGET_CHARS -
          JSON.stringify({ health, metrics, unread }).length -
          200,
      );
      const more =
        fitted.left_out > 0 ||
        (connectors.ok && typeof connectors.data.next_cursor === "string");
      return ok({
        health,
        ...(metrics !== undefined && { metrics }),
        ...(connectors.ok && { connectors: fitted.kept }),
        ...(more && { connectors_left_out: true }),
        ...(unread.length > 0 && { unread }),
      });
    },
  );
}

export const AUDIT_MAX_ENTRIES = 50;

const auditOutput = z.object({
  entries: z.array(z.looseObject({ id: z.string(), action: z.string() })),
  next_cursor: z.string().nullable(),
  left_out: z.number().optional(),
  next: z.string().optional(),
});

export function registerAudit(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "marfa_audit",
    {
      title: "Read the audit log",
      description:
        "Use to see what changed and who did it: changes, sign-ins, exports and the files tools fetched, newest first. Narrow it with the filters, and pass next_cursor to read further back.",
      inputSchema: z.strictObject({
        q: z
          .string()
          .min(1)
          .optional()
          .describe("Only entries that hold every word of this text."),
        action: z.string().min(1).optional().describe("Such as `key.create`."),
        resource_type: z.string().min(1).optional().describe("Such as `key`."),
        resource_id: z.string().min(1).optional(),
        kind: z.enum(["access", "data", "settings", "housekeeping"]).optional(),
        created_after: z.string().optional().describe("An RFC 3339 time."),
        created_before: z.string().optional().describe("An RFC 3339 time."),
        limit: z.number().int().min(1).max(AUDIT_MAX_ENTRIES).default(20),
        cursor: z.string().min(1).optional(),
      }),
      outputSchema: auditOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (query) => {
      const answer = await ctx.api.answer(
        ctx.api.client.GET("/audit", { params: { query } }),
      );
      if (!answer.ok) return refused(answer.refusal);
      const fitted = fitList(answer.data.data, ANSWER_BUDGET_CHARS - 500);
      if (fitted.left_out === 0) {
        return ok({
          entries: fitted.kept,
          next_cursor: answer.data.next_cursor ?? null,
        });
      }
      // The page's cursor points past the entries this answer leaves out,
      // so it is withheld rather than skip them.
      return ok({
        entries: fitted.kept,
        next_cursor: null,
        left_out: fitted.left_out,
        next: `${String(fitted.left_out)} entries did not fit. Call again with limit ${String(fitted.kept.length)} or less, and page from there.`,
      });
    },
  );
}

import type { McpServer } from "@modelcontextprotocol/server";
import type { components } from "@withmarfa/client";
import { PERMISSIONS, type Permission } from "@withmarfa/shared";
import * as z from "zod";
import { itemId } from "../args.js";
import {
  checkConfirmation,
  confirmationToken,
  staleConfirmation,
} from "../confirm.js";
import type { ToolContext } from "../context.js";
import { ANSWER_BUDGET_CHARS, fail, fitList, ok, refused } from "../results.js";

type ApiKey = components["schemas"]["ApiKey"];

/** A key as the tools show it: what it reaches, without its secret. */
function keyView(key: ApiKey, ctx: ToolContext) {
  return {
    id: key.id,
    label: key.label,
    source: key.source,
    ...(key.sources.length > 0 && { sources: key.sources }),
    permissions: key.permissions,
    type_permissions: key.type_permissions,
    ...(Object.keys(key.metadata_permissions).length > 0 && {
      metadata_permissions: key.metadata_permissions,
    }),
    ...(key.oauth_client_id !== undefined && {
      oauth_client_id: key.oauth_client_id,
    }),
    created_at: key.created_at,
    expires_at: key.expires_at,
    last_used_at: key.last_used_at,
    ...(key.id === ctx.callerKeyId && { yours: true }),
  };
}

/** What a revoke's confirmation covers: the key as it reaches, not its use. */
function revokedSubject(key: ApiKey) {
  return Object.fromEntries(
    Object.entries(key).filter(([name]) => name !== "last_used_at"),
  );
}

async function reachableKeys(ctx: ToolContext) {
  return ctx.api.answer(ctx.api.client.GET("/keys"));
}

const keyShape = z.looseObject({ id: z.string(), label: z.string() });

export function registerKeys(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "marfa_keys",
    {
      title: "List keys",
      description:
        "Use to see the API keys this credential can reach: what each may read and write, and when it was last used. The key you are using is marked yours.",
      inputSchema: z.strictObject({}),
      outputSchema: z.object({
        keys: z.array(keyShape),
        left_out: z.number().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const answer = await reachableKeys(ctx);
      if (!answer.ok) return refused(answer.refusal);
      const fitted = fitList(
        answer.data.data.map((key) => keyView(key, ctx)),
        ANSWER_BUDGET_CHARS - 200,
      );
      return ok({
        keys: fitted.kept,
        ...(fitted.left_out > 0 && { left_out: fitted.left_out }),
      });
    },
  );
}

const permissionList = z
  .array(z.enum(PERMISSIONS as [Permission, ...Permission[]]))
  .describe("Permissions, such as `audit.read`.");
const typeMap = z
  .record(z.string(), z.enum(["read", "write", "none"]))
  .describe('Types by ID or wildcard, such as {"core.*": "read"}.');
const levelMap = z.record(z.string(), z.enum(["read", "write"]));

export function registerManageKey(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "marfa_manage_key",
    {
      title: "Make or narrow a key",
      description:
        "Use to make an API key for an app or script, or to narrow what a key may reach. A key never gets more than this credential holds; a new key that names no permissions or maps gets all of it, so name only what the key needs. Making a key returns its secret once: give it to the person, who keeps it.",
      inputSchema: z.strictObject({
        action: z.enum(["make", "narrow"]),
        id: itemId.optional().describe("The key to narrow."),
        label: z.string().min(1).optional().describe("Required to make a key."),
        source: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Required to make a key: a name unique to it, stamped on what it saves.",
          ),
        permissions: permissionList.optional(),
        type_permissions: typeMap.optional(),
        edge_permissions: levelMap.optional(),
        metadata_permissions: levelMap.optional(),
        expires_at: z
          .string()
          .optional()
          .describe("When the key stops working (RFC 3339)."),
      }),
      outputSchema: z.object({
        key: keyShape,
        secret: z.string().optional(),
        next: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ action, id, label, source, ...given }) => {
      if (action === "make") {
        if (label === undefined || source === undefined) {
          return fail({
            code: "missing_required_field",
            message: "A new key needs a label and a source.",
          });
        }
        const answer = await ctx.api.answer(
          ctx.api.client.POST("/keys", {
            body: { label, source, ...given },
          }),
        );
        if (!answer.ok) return refused(answer.refusal);
        const { key: secret, ...made } = answer.data;
        return ok({
          key: keyView({ ...made, last_used_at: null }, ctx),
          secret,
          next: "Give the secret to the person now: Marfa never shows it again.",
        });
      }
      if (id === undefined) {
        return fail({
          code: "missing_required_field",
          message: "Name the key to narrow with id.",
        });
      }
      if (source !== undefined) {
        return fail({
          code: "validation_error",
          message: "A key's source cannot change.",
        });
      }
      const answer = await ctx.api.answer(
        ctx.api.client.PATCH("/keys/{id}", {
          params: { path: { id } },
          body: {
            ...(label !== undefined && { label }),
            ...given,
            narrow_only: true,
          },
        }),
      );
      if (!answer.ok) return refused(answer.refusal);
      return ok({ key: keyView(answer.data, ctx) });
    },
  );
}

export function registerRevokeKey(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "marfa_revoke_key",
    {
      title: "Revoke a key",
      description:
        "Use to stop a key working for good. The first call previews the key; show it to the person, and call again with the same id and confirm to revoke it. Its webhooks are deleted with it.",
      inputSchema: z.strictObject({
        id: itemId.describe("The key's ID, from marfa_keys."),
        confirm: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The confirm token from the preview. Leave out to preview.",
          ),
      }),
      outputSchema: z.object({
        key: keyShape.optional(),
        confirm: z.string().optional(),
        expires_at: z.string().optional(),
        revoked: z.string().optional(),
        next: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id, confirm }) => {
      const listed = await reachableKeys(ctx);
      if (!listed.ok) return refused(listed.refusal);
      const key = listed.data.data.find((one) => one.id === id);
      if (key === undefined) {
        return fail({
          code: "api_key_not_found",
          message:
            "No key this credential can reach has this ID, or it is revoked or expired.",
          hint: "Call marfa_keys to see the keys.",
        });
      }
      const yours = key.id === ctx.callerKeyId;
      const scope = {
        tool: "marfa_revoke_key",
        credential: ctx.credentialHandle,
      };
      const subject = revokedSubject(key);

      const previewAnswer = (
        extra: { code: string; message: string } | null,
      ) => {
        const token = confirmationToken(
          ctx.confirmKey,
          scope,
          subject,
          ctx.now(),
        );
        const body = {
          key: keyView(key, ctx),
          confirm: token.token,
          expires_at: token.expires_at,
          next: `Nothing has been revoked. ${yours ? "This is the key you are using: once it is revoked, this connection stops working. " : ""}Revoking ends its event streams and queued bulk actions and deletes its webhooks. Show the person, and call again with the same id and confirm to revoke it.`,
        };
        return extra === null ? ok(body) : fail({ ...extra, ...body });
      };

      if (confirm === undefined) return previewAnswer(null);
      const check = checkConfirmation(
        ctx.confirmKey,
        scope,
        subject,
        confirm,
        ctx.now(),
      );
      if (check !== "valid") {
        return previewAnswer(staleConfirmation(check, "Nothing was revoked"));
      }
      const answer = await ctx.api.answer(
        ctx.api.client.DELETE("/keys/{id}", { params: { path: { id } } }),
      );
      if (!answer.ok) return refused(answer.refusal);
      return ok({
        revoked: id,
        next: yours
          ? "Revoked. This was the key you were using, so this connection no longer works."
          : "Revoked.",
      });
    },
  );
}

import type { CreateItemInput, ItemState } from "@myme/shared";
import { checkAuth, checkTypeAccess } from "../../middleware/auth.js";
import type { GraphQLContext } from "../context.js";
import { publish } from "../pubsub.js";

export const mutationResolvers = {
  createItem: async (
    _: unknown,
    args: { input: CreateItemInput },
    ctx: GraphQLContext,
  ) => {
    checkAuth(ctx.apiKey);
    checkTypeAccess(ctx.apiKey, args.input.type, "write");

    const item = await ctx.storage.items.create(args.input);
    const metadata = await ctx.storage.metadata.get(item.id);

    publish({ type: "created", item, metadata });
    return { item, metadata };
  },

  updateItem: async (
    _: unknown,
    args: { id: string; properties: Record<string, unknown>; version?: number },
    ctx: GraphQLContext,
  ) => {
    checkAuth(ctx.apiKey);
    const existing = await ctx.storage.items.get(args.id);
    if (existing) checkTypeAccess(ctx.apiKey, existing.type, "write");

    const result = await ctx.storage.items.update(args.id, {
      properties: args.properties,
      version: args.version,
    });

    // If conflict, the result is a ConflictResponse — throw as error
    if ("error" in result) {
      const { GraphQLError } = await import("graphql");
      throw new GraphQLError("Version conflict", {
        extensions: {
          code: "VERSION_CONFLICT",
          current: result.current,
          ancestor: result.ancestor,
          conflicting_fields: result.conflicting_fields,
        },
      });
    }

    const metadata = await ctx.storage.metadata.get(result.id);
    publish({ type: "updated", item: result, metadata });
    return { item: result, metadata };
  },

  deleteItem: async (
    _: unknown,
    args: { id: string },
    ctx: GraphQLContext,
  ) => {
    checkAuth(ctx.apiKey);
    const existing = await ctx.storage.items.get(args.id);
    if (existing) checkTypeAccess(ctx.apiKey, existing.type, "write");

    await ctx.storage.items.delete(args.id);

    if (existing) {
      const metadata = await ctx.storage.metadata.get(args.id);
      publish({ type: "deleted", item: { ...existing, state: "trashed" as ItemState }, metadata });
    }

    return { ok: true };
  },

  restoreItem: async (
    _: unknown,
    args: { id: string },
    ctx: GraphQLContext,
  ) => {
    checkAuth(ctx.apiKey);
    const item = await ctx.storage.items.restore(args.id);
    checkTypeAccess(ctx.apiKey, item.type, "write");

    const metadata = await ctx.storage.metadata.get(item.id);
    publish({ type: "restored", item, metadata });
    return { item, metadata };
  },

  transitionItem: async (
    _: unknown,
    args: { id: string; state: string },
    ctx: GraphQLContext,
  ) => {
    checkAuth(ctx.apiKey);
    const item = await ctx.storage.items.transition(args.id, args.state as ItemState);
    checkTypeAccess(ctx.apiKey, item.type, "write");

    const metadata = await ctx.storage.metadata.get(item.id);
    publish({ type: "transitioned", item, metadata });
    return { item, metadata };
  },

  addTags: async (
    _: unknown,
    args: { itemId: string; tags: string[] },
    ctx: GraphQLContext,
  ) => {
    checkAuth(ctx.apiKey);
    const metadata = await ctx.storage.metadata.addTags(args.itemId, args.tags);
    return { metadata };
  },

  removeTag: async (
    _: unknown,
    args: { itemId: string; tag: string },
    ctx: GraphQLContext,
  ) => {
    checkAuth(ctx.apiKey);
    const metadata = await ctx.storage.metadata.removeTag(args.itemId, args.tag);
    return { metadata };
  },

  setMetadata: async (
    _: unknown,
    args: { itemId: string; tags?: string[]; about?: string[] },
    ctx: GraphQLContext,
  ) => {
    checkAuth(ctx.apiKey);
    const metadata = await ctx.storage.metadata.set(args.itemId, args.tags, args.about);
    return { metadata };
  },
};

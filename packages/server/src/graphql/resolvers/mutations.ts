import type { CreateItemInput, ItemState } from "@myme/shared";
import { createGraphQLError } from "graphql-yoga";
import {
  gqlCheckAuth,
  gqlCheckTypeAccess,
  type GraphQLContext,
} from "../context.js";
import { publish } from "../pubsub.js";

/** Fetch an item or throw not-found as GraphQLError. */
async function requireItem(ctx: GraphQLContext, id: string) {
  const item = await ctx.storage.items.get(id);
  if (!item) {
    throw createGraphQLError(`Item ${id} not found`, {
      extensions: { code: "item_not_found" },
    });
  }
  return item;
}

export const mutationResolvers = {
  createItem: async (
    _: unknown,
    args: { input: CreateItemInput },
    ctx: GraphQLContext,
  ) => {
    gqlCheckAuth(ctx.apiKey);
    gqlCheckTypeAccess(ctx.apiKey, args.input.type, "write");

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
    gqlCheckAuth(ctx.apiKey);
    const existing = await requireItem(ctx, args.id);
    gqlCheckTypeAccess(ctx.apiKey, existing.type, "write");

    const result = await ctx.storage.items.update(args.id, {
      properties: args.properties,
      version: args.version,
    });

    if ("error" in result) {
      throw createGraphQLError("Version conflict", {
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
    gqlCheckAuth(ctx.apiKey);
    const existing = await requireItem(ctx, args.id);
    gqlCheckTypeAccess(ctx.apiKey, existing.type, "write");

    await ctx.storage.items.delete(args.id);

    const metadata = await ctx.storage.metadata.get(args.id);
    publish({ type: "deleted", item: { ...existing, state: "trashed" as ItemState }, metadata });

    return { ok: true };
  },

  restoreItem: async (
    _: unknown,
    args: { id: string },
    ctx: GraphQLContext,
  ) => {
    gqlCheckAuth(ctx.apiKey);
    // restore() handles fetching trashed items internally — check type after
    // Note: we can't pre-check because get() excludes trashed items.
    // The storage layer will throw if the item doesn't exist.
    const item = await ctx.storage.items.restore(args.id);
    // Type access is checked after restore since we need the item's type
    gqlCheckTypeAccess(ctx.apiKey, item.type, "write");

    const metadata = await ctx.storage.metadata.get(item.id);
    publish({ type: "restored", item, metadata });
    return { item, metadata };
  },

  transitionItem: async (
    _: unknown,
    args: { id: string; state: string },
    ctx: GraphQLContext,
  ) => {
    gqlCheckAuth(ctx.apiKey);
    const existing = await requireItem(ctx, args.id);
    gqlCheckTypeAccess(ctx.apiKey, existing.type, "write");

    const item = await ctx.storage.items.transition(args.id, args.state as ItemState);

    const metadata = await ctx.storage.metadata.get(item.id);
    publish({ type: "transitioned", item, metadata });
    return { item, metadata };
  },

  addTags: async (
    _: unknown,
    args: { itemId: string; tags: string[] },
    ctx: GraphQLContext,
  ) => {
    gqlCheckAuth(ctx.apiKey);
    const item = await requireItem(ctx, args.itemId);
    gqlCheckTypeAccess(ctx.apiKey, item.type, "write");

    const metadata = await ctx.storage.metadata.addTags(args.itemId, args.tags);
    return { metadata };
  },

  removeTag: async (
    _: unknown,
    args: { itemId: string; tag: string },
    ctx: GraphQLContext,
  ) => {
    gqlCheckAuth(ctx.apiKey);
    const item = await requireItem(ctx, args.itemId);
    gqlCheckTypeAccess(ctx.apiKey, item.type, "write");

    const metadata = await ctx.storage.metadata.removeTag(args.itemId, args.tag);
    return { metadata };
  },

  setMetadata: async (
    _: unknown,
    args: { itemId: string; tags?: string[]; about?: string[] },
    ctx: GraphQLContext,
  ) => {
    gqlCheckAuth(ctx.apiKey);
    const item = await requireItem(ctx, args.itemId);
    gqlCheckTypeAccess(ctx.apiKey, item.type, "write");

    const metadata = await ctx.storage.metadata.set(args.itemId, args.tags ?? [], args.about ?? []);
    return { metadata };
  },
};

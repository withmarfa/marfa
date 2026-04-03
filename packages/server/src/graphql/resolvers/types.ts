import type { Item, Thread } from "@mymehq/shared";
import type { GraphQLContext } from "../context.js";

export const typeResolvers = {
  Item: {
    metadata: (parent: Item, _args: unknown, ctx: GraphQLContext) => {
      return ctx.storage.metadata.get(parent.id);
    },
  },

  Thread: {
    items: (parent: Thread, _args: unknown, ctx: GraphQLContext) => {
      return ctx.storage.threads.getItems(parent.id, ctx.apiKey?.tenant_id);
    },
  },
};

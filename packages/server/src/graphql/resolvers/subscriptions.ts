import { checkAuth } from "../../middleware/auth.js";
import type { GraphQLContext } from "../context.js";
import { subscribe } from "../pubsub.js";

export const subscriptionResolvers = {
  itemChanged: {
    subscribe: (
      _: unknown,
      args: { type?: string },
      ctx: GraphQLContext,
    ) => {
      checkAuth(ctx.apiKey);
      return subscribe(args.type);
    },
    resolve: (payload: unknown) => payload,
  },
};

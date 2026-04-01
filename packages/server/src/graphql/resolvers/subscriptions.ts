import { matchesTypePattern } from "@myme/shared";
import {
  gqlCheckAuth,
  gqlCheckTypeAccess,
  computeTypeFilter,
  type GraphQLContext,
} from "../context.js";
import { subscribe, type ItemEvent } from "../pubsub.js";

export const subscriptionResolvers = {
  itemChanged: {
    subscribe: (
      _: unknown,
      args: { type?: string },
      ctx: GraphQLContext,
    ) => {
      gqlCheckAuth(ctx.apiKey);

      // If a specific type is requested, verify the key has read access
      if (args.type) {
        gqlCheckTypeAccess(ctx.apiKey, args.type, "read");
        return subscribe(args.type);
      }

      // No type filter: wrap the iterator to filter by allowed types
      const allowedTypes = computeTypeFilter(ctx.apiKey);
      if (!allowedTypes) {
        // Admin — no filtering needed
        return subscribe();
      }

      // Member — filter events to only allowed types
      return filterByAllowedTypes(subscribe(), allowedTypes);
    },
    resolve: (payload: unknown) => payload,
  },
};

async function* filterByAllowedTypes(
  source: AsyncGenerator<ItemEvent>,
  allowedTypes: string[],
): AsyncGenerator<ItemEvent> {
  for await (const event of source) {
    if (matchesTypePattern(event.item.type, allowedTypes)) {
      yield event;
    }
  }
}

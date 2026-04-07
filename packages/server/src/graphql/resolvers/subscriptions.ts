import { matchesTypePattern, isValidTypeIdentifier } from "@myme/shared";
import {
  gqlCheckAuth,
  gqlCheckTypeAccess,
  computeTypeFilter,
  type GraphQLContext,
} from "../context.js";
import { subscribe, type ItemEvent } from "../pubsub.js";

export const subscriptionResolvers = {
  itemChanged: {
    subscribe: (_: unknown, args: { type?: string }, ctx: GraphQLContext) => {
      const apiKey = gqlCheckAuth(ctx.apiKey);
      const tenantId = apiKey.tenant_id;

      // If a specific type is requested, validate and verify access
      if (args.type) {
        if (!isValidTypeIdentifier(args.type)) {
          throw new Error("Invalid type identifier");
        }
        gqlCheckTypeAccess(ctx.apiKey, args.type, "read");
        return subscribe({ typeFilter: args.type, tenantId });
      }

      // No type filter: wrap the iterator to filter by allowed types
      const allowedTypes = computeTypeFilter(ctx.apiKey);
      if (!allowedTypes) {
        // Admin — no filtering needed (but still scope to tenant)
        return subscribe({ tenantId });
      }

      // Member — filter events to only allowed types
      return filterByAllowedTypes(subscribe({ tenantId }), allowedTypes);
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

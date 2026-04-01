import { createYoga, createSchema } from "graphql-yoga";
import { GraphQLJSON } from "graphql-scalars";
import type { Hono } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { GraphQLContext } from "./context.js";
import { typeDefs } from "./schema.js";
import { queryResolvers } from "./resolvers/queries.js";
import { mutationResolvers } from "./resolvers/mutations.js";
import { subscriptionResolvers } from "./resolvers/subscriptions.js";
import { typeResolvers } from "./resolvers/types.js";

export function mountGraphQL(app: Hono<AppEnv>, storage: Storage): void {
  const yoga = createYoga<GraphQLContext>({
    schema: createSchema<GraphQLContext>({
      typeDefs,
      resolvers: {
        JSON: GraphQLJSON,
        Query: queryResolvers,
        Mutation: mutationResolvers,
        Subscription: subscriptionResolvers,
        ...typeResolvers,
      },
    }),
    graphiql: process.env.NODE_ENV !== "production",
    logging: false,
  });

  app.on(["GET", "POST"], "/graphql", async (c) => {
    const response = await yoga.handleRequest(c.req.raw, {
      apiKey: c.get("apiKey"),
      authType: c.get("authType"),
      storage,
    });
    return new Response(response.body, {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
    });
  });
}

/**
 * Cloudflare Worker entrypoint for the template Integration.
 * All integrations follow this same shape.
 */
import { PerConnectionState, registerHandlers } from "./_runtime.js";

registerHandlers();

export { PerConnectionState };

export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext): Response {
    void request;
    void env;
    void ctx;
    return new Response(
      JSON.stringify({
        ok: true,
        integration: "marfa.template",
        message:
          "Template Integration. Queue handlers registered; HTTP surface unused.",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  },
};

/**
 * Cloudflare Worker entrypoint for the GitHub Webhooks integration.
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
        integration: "mymehq.github-webhooks",
        message:
          "GitHub Webhooks Integration. Webhook handler registered; HTTP surface unused (deliveries flow via the inbound webhook subsystem and the reactive queue).",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  },
};

/**
 * Cloudflare Worker entrypoint for the template Integration.
 *
 * Layer 1 PR 2 ships the handler registration only; the queue
 * consumer that calls `dispatchMessage` lands in PR 3 (along with the
 * full DO + queue wiring).
 *
 * Layer 3 integrations follow this same shape:
 *   1. Import handlers + registerHandlers() from ./handlers.
 *   2. Re-export PerConnectionState so the DO binding resolves.
 *   3. Export a default { fetch } for any HTTP routes the integration
 *      needs (most don't — most work flows through queues).
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
          "Template Integration. Queue handlers registered; HTTP surface unused. PR 3 wires the queue consumer.",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  },
};

/**
 * Cloudflare Worker entrypoint for the Google Calendar integration.
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
        integration: "mymehq.google-calendar",
        message:
          "Google Calendar Integration. Schedule (inbound) + item-event (outbound) handlers registered; HTTP surface unused.",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  },
};

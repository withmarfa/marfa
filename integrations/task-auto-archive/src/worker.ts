/**
 * Cloudflare Worker entrypoint for the Task Auto-Archive integration.
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
        integration: "mymehq.task-auto-archive",
        message:
          "Task Auto-Archive Integration. Item-event + schedule handlers registered; HTTP surface unused.",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  },
};

/**
 * Cloudflare Worker entrypoint for the RSS Watcher integration.
 *
 * Same shape as the template:
 *   1. Import + register handlers at module load.
 *   2. Re-export PerConnectionState so the DO binding resolves.
 *   3. Default fetch returns a small JSON sentinel — HTTP unused.
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
        integration: "mymehq.rss-watcher",
        message:
          "RSS Watcher Integration. Schedule handler registered; HTTP surface unused.",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  },
};

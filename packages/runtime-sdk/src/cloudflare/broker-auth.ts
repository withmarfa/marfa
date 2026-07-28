import { isBrokerAuthorized } from "@withmarfa/shared";

/**
 * Reject a caller that did not present this Worker's identity key.
 * Returns the refusal to hand back, or `null` when the caller is
 * authorized.
 *
 * The Worker-shaped half of the same comparison the control plane
 * applies: same `Response | null` contract, same rule
 * (`isBrokerAuthorized` in `@withmarfa/shared`). Two wrappers rather
 * than one because the runtimes differ — the control plane answers
 * through a Hono context, an integration Worker answers with a bare
 * `Response`, and this package must not take a Hono dependency it would
 * ship into every integration bundle.
 *
 * The direction is the mirror of the lease broker: the Worker presents
 * this key when it mints a credential, the control plane derives the
 * same value and presents it when it dispatches here. One secret per
 * Worker, checked both ways — and not the platform broker key, which
 * never reaches an integration Worker in either direction.
 *
 * A Service Binding authenticates by topology — only Workers in the
 * same account with the binding declared can reach the handler. That
 * is not enough on its own: `workers_dev`, `preview_urls`, a `routes`
 * entry, or a new binding all re-expose the same `fetch` handler, and
 * none of those changes touch this file. The route verifies its caller
 * so the topology is a second layer rather than the only one.
 *
 * Fails closed when the key is unset, with a distinct status so an
 * operator can tell a Worker missing its secrets from a caller
 * presenting the wrong one. A Worker deployed without secrets must
 * refuse the request, not accept `Bearer undefined`.
 *
 * Async only because the shared comparison is constant-time, and Web
 * Crypto is the one constant-time primitive a Workers isolate has.
 */
export async function brokerAuthFailure(
  request: Request,
  identityKey: string | undefined,
): Promise<Response | null> {
  if (!identityKey) {
    return Response.json(
      {
        ok: false,
        error: "worker_misconfigured",
        message: "MARFA_WORKER_IDENTITY_KEY must be set.",
      },
      { status: 503 },
    );
  }
  if (
    !(await isBrokerAuthorized(
      request.headers.get("authorization"),
      identityKey,
    ))
  ) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return null;
}

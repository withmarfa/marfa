import { isBrokerAuthorized } from "@withmarfa/shared";

/**
 * Reject a caller that did not present the broker key. Returns the
 * refusal to hand back, or `null` when the caller is authorized.
 *
 * The Worker-shaped half of the same gate the control plane applies in
 * `@withmarfa/runtime-control`'s `brokerAuthFailure`: same name, same
 * `Response | null` contract, same rule (`isBrokerAuthorized` in
 * `@withmarfa/shared`). Two wrappers rather than one because the
 * runtimes differ — the control plane answers through a Hono context,
 * an integration Worker answers with a bare `Response`, and this
 * package must not take a Hono dependency it would ship into every
 * integration bundle.
 *
 * The direction is the mirror of the lease broker: the Worker presents
 * this key when it mints a credential, the control plane presents it
 * when it dispatches here. One shared secret, checked both ways.
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
 */
export function brokerAuthFailure(
  request: Request,
  brokerKey: string | undefined,
): Response | null {
  if (!brokerKey) {
    return Response.json(
      {
        ok: false,
        error: "worker_misconfigured",
        message: "MARFA_RUNTIME_BROKER_KEY must be set.",
      },
      { status: 503 },
    );
  }
  if (!isBrokerAuthorized(request.headers.get("authorization"), brokerKey)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return null;
}

import type { Context } from "hono";
import {
  INTEGRATION_NAME_HEADER,
  deriveWorkerIdentityKey,
  isBrokerAuthorized,
} from "@withmarfa/shared";
import type { ControlPlaneEnv } from "./env.js";

/**
 * Both halves of the per-Worker identity contract: proving who an
 * inbound integration Worker is, and proving to a Worker who the
 * control plane is.
 *
 * The platform broker key is the credential that can mint against any
 * Connection in any tenant, so it stays on this side of the boundary and
 * is never presented to a Worker or accepted from one. What crosses is a
 * key derived per integration (see `deriveWorkerIdentityKey` in
 * `@withmarfa/shared`), which authenticates one Worker and no other.
 */

/**
 * Authenticate an inbound integration Worker and return the integration
 * name it proved.
 *
 * The caller states a name in a header and presents a bearer. Neither is
 * trusted alone: the name selects which derived key to compare against,
 * and the bearer is what has to match it. A caller naming an integration
 * it is not gets the key for that integration and fails the comparison,
 * so the header can only narrow what a caller may be.
 *
 * The returned name is therefore an authenticated fact, and it is the
 * value the lease route forwards to the Marfa server, which checks it
 * against the manifest persisted on the requested Connection. A Worker
 * that has somehow obtained another integration's Connection id is
 * refused there.
 *
 * Fails closed on an unset root secret, with a status that separates
 * "this control plane is missing its secret" from "this caller is not
 * who it says". A deployment without the secret must refuse every
 * caller rather than derive from an empty string, which would hand
 * every equally misconfigured deployment the same fleet-wide key.
 */
export async function authenticateWorker(
  c: Context<{ Bindings: ControlPlaneEnv }>,
): Promise<
  { ok: true; integrationName: string } | { ok: false; response: Response }
> {
  const root = c.env.MARFA_WORKER_IDENTITY_SECRET;
  if (!root) {
    return {
      ok: false,
      response: c.json(
        {
          error: "control_plane_misconfigured",
          message: "MARFA_WORKER_IDENTITY_SECRET must be set.",
        },
        503,
      ),
    };
  }

  const claimed = c.req.header(INTEGRATION_NAME_HEADER);
  if (!claimed) {
    // Same 401 an unauthenticated caller gets, deliberately. Telling a
    // caller which header it omitted describes the gate to whoever is
    // probing it, and a Worker that has been deployed correctly never
    // sees this branch.
    return { ok: false, response: c.json({ error: "unauthorized" }, 401) };
  }

  const expected = await deriveWorkerIdentityKey(root, claimed);
  if (!(await isBrokerAuthorized(c.req.header("authorization"), expected))) {
    return { ok: false, response: c.json({ error: "unauthorized" }, 401) };
  }
  return { ok: true, integrationName: claimed };
}

/**
 * The bearer the control plane presents when it dispatches into an
 * integration Worker over a Service Binding.
 *
 * The same derived value the Worker authenticates inbound callers with,
 * so one secret per Worker covers both directions of the hop. The
 * platform broker key used to travel here; it no longer does, which is
 * the point — a Worker that only ever receives its own derived key
 * cannot replay a platform credential anywhere.
 */
export function workerDispatchAuthorization(
  rootSecret: string,
  integrationName: string,
): Promise<string> {
  return deriveWorkerIdentityKey(rootSecret, integrationName).then(
    (key) => `Bearer ${key}`,
  );
}

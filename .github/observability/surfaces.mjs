/**
 * The fleet this watcher can see, and the fleet it deliberately cannot.
 *
 * Everything listed in SURFACES is reachable from the public internet, which
 * is the whole point: the watcher runs on GitHub-hosted infrastructure so it
 * shares no failure domain with the things it watches. A surface that can
 * only be reached from inside a private network is, by definition, invisible
 * here — those are enumerated in UNREACHABLE_SURFACES so the gap is written
 * down rather than merely absent.
 */

/**
 * `kind: "server"` surfaces return the Marfa `/health` payload: a `status`
 * field, a `components` map whose entries carry their own status, and a
 * `version.sha` used for deploy-drift comparison.
 *
 * `kind: "static"` surfaces are prerendered sites or SPA bundles on a CDN.
 * They have no health payload and no build SHA — a 200 is the whole signal.
 */
export const SURFACES = [
  {
    id: "production",
    label: "Production API",
    url: "https://api.marfa.so/health",
    kind: "server",
    // The environment label used by the deploy pipeline and by telemetry.
    environment: "prod",
  },
  {
    id: "staging",
    label: "Staging API",
    url: "https://staging.marfa.so/health",
    kind: "server",
    environment: "staging",
  },
  {
    id: "docs",
    label: "Documentation site",
    url: "https://docs.marfa.so/",
    kind: "static",
  },
  {
    id: "tickets",
    label: "Tickets app",
    url: "https://tickets.marfa.so/",
    kind: "static",
  },
  {
    id: "web-app",
    label: "Web app",
    url: "https://app.marfa.so/",
    kind: "static",
  },
];

/**
 * Surfaces this watcher structurally cannot probe, with the reason and the
 * compensating control. Rendered into the run summary on every execution so
 * a green report never reads as "the whole fleet is fine".
 *
 * Both entries below sit behind a private network boundary with no public
 * ingress. A hosted runner has no route to them, and giving it one would
 * mean punching a hole in the boundary purely to satisfy a monitor — a worse
 * trade than accepting the blind spot and covering it host-side.
 */
export const UNREACHABLE_SURFACES = [
  {
    label: "Self-hosted server",
    reason: "private-network only, no public ingress",
    covered_by:
      "host-side readiness gate on the service wrapper plus log rotation",
  },
  {
    label: "Operator console",
    reason: "private-network only, no public ingress",
    covered_by: "host-side service supervision",
  },
];

/** Server surfaces carry a build SHA and take part in drift comparison. */
export function serverSurfaces() {
  return SURFACES.filter((s) => s.kind === "server");
}

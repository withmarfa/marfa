/**
 * How a run's signals become a verdict and a summary.
 *
 * Split out of `check.mjs` because `check.mjs` is a script: it runs its work
 * on import, so nothing in it can be reached from a test. The two decisions
 * below are the ones most argued for in this directory and were the two least
 * covered — which is the wrong way round for logic whose failure mode is a
 * monitor that looks like it is working.
 */

/**
 * Split the run's findings into the fleet's and the watcher's own.
 *
 * Both alert; only the fleet's decide the verdict recorded on this run's
 * heartbeat, because that verdict answers "was the fleet healthy?" and a gap
 * in the watcher's own history is not an answer to it.
 *
 * Keeping the oscillation finding out of that verdict also breaks a loop. The
 * finding is derived from the `healthy` values on previous heartbeats, so
 * recording it would feed the detector's own output back into the sequence it
 * reads next time — which can manufacture the very transitions it counts: a
 * green fleet plus a firing detector records unhealthy, the next run records
 * healthy again, and that flip is entirely the detector's own. It would also
 * hold the alert open past the point where its text ("something is recovering
 * and failing again") is still true.
 */
export function splitFindings({
  liveness,
  drift,
  telemetry,
  heartbeat,
  oscillation,
  projectMatch,
}) {
  const fleetFindings = [
    ...liveness.findings,
    ...drift.findings,
    ...telemetry.findings,
  ];
  const allFindings = [
    ...heartbeat.findings,
    ...oscillation.findings,
    ...projectMatch.findings,
    ...fleetFindings,
  ];
  return {
    fleetFindings,
    allFindings,
    red: allFindings.filter((f) => f.severity === "red"),
    warn: allFindings.filter((f) => f.severity === "warn"),
    fleetHealthy: !fleetFindings.some((f) => f.severity === "red"),
  };
}

/**
 * One line describing what the watchdog had to work with this run.
 *
 * Both watchdog checks are quiet when the history is thin, and quiet is what
 * a healthy fleet looks like too. The distinction has to be written down
 * somewhere a human will see it. This is also where the derived gap tolerance
 * surfaces — it is the number an operator most needs and the one nothing else
 * prints.
 */
export function describeHistory(heartbeat, oscillation) {
  if (!heartbeat.configured) return "not checked (not configured)";
  if (heartbeat.unknown) return "UNAVAILABLE — history could not be read";
  if (heartbeat.firstRun) {
    return "empty — first scheduled run, or the previous one aged out";
  }

  // A history that arrived and could not be read at all is not a steady
  // fleet. Saying "0 flip(s) across 0 run(s)" beside a populated gap baseline
  // would describe a silently dead detector in the same words it uses for a
  // healthy one.
  const flapping = oscillation.unknown
    ? `${String(oscillation.beats ?? 0)} recent run(s) recorded a verdict this ` +
      "reader could not interpret, so flapping is UNKNOWN"
    : `${String(oscillation.flips)} flip(s) across ${String(oscillation.runs)} recent run(s)`;

  if (!heartbeat.baselineKnown) {
    return `too few scheduled runs yet to establish a normal interval; ${flapping}`;
  }

  return (
    `normal interval ~${String(heartbeat.baselineMinutes)} min ` +
    `(median of ${String(heartbeat.samples)}), gap tolerance ` +
    `${String(heartbeat.toleranceMinutes)} min — nothing shorter than that can be ` +
    `reported as a blackout; ${flapping}`
  );
}

/**
 * The lines that state what this run could and could not see.
 *
 * A markdown list, not consecutive paragraphs of prose: rendered as plain
 * lines they collapse into one run-on sentence, and the place the fail-closed
 * trade is supposed to be legible is the last place that should read as an
 * afterthought.
 */
export function visibilityLines({
  alert,
  heartbeat,
  oscillation,
  projectMatch,
  beat,
  unobservablePairing = [],
}) {
  const lines = [
    `- **Alert issue:** ${alert.action}${alert.url ? ` — ${alert.url}` : ""}`,
    // Both watchdog checks fail closed — no history means no findings, which
    // reads as health. Stating what the history actually was on every run is
    // what stops that being invisible.
    `- **Watchdog history:** ${describeHistory(heartbeat, oscillation)}`,
    `- **Watchdog project:** ${projectMatch.note}`,
    `- **Heartbeat:** ${
      beat.emitted
        ? "emitted"
        : `not emitted (${String(beat.reason ?? beat.status)})`
    }${heartbeat.lastSeen ? `, previous ${String(heartbeat.ageMinutes)} min ago` : ""}`,
  ];

  if (heartbeat.unmarked > 0) {
    lines.push(
      `- **Heartbeat marker:** ${String(heartbeat.unmarked)} of the beats read predate the ` +
        "trigger marker and are being counted as scheduled history. They age " +
        "out of the lookback on their own.",
    );
  }

  if (unobservablePairing.length > 0) {
    lines.push(
      `- **Restart pairing:** not judged for ${unobservablePairing.join("; ")}. ` +
        "An unrecorded clean stop is not evidence of an unclean one, so the " +
        "unpaired-restart check is held rather than reported for these.",
    );
  }

  return lines;
}

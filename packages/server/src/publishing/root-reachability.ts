/**
 * Every symbol a published package's modules export should be reachable
 * from its package root, or named as a deliberate exclusion with a reason.
 *
 * The runtime kit's `index.ts` describes itself as the surface integrations
 * import and is a hand-maintained list. The modules behind it export
 * freely, so nothing relates the two, and by the time anyone looked three
 * symbols had been missed: an options type, an arm of an exported union
 * whose three siblings were all listed, and the parameter type of an
 * exported function. A fourth turned up while writing this — `CYCLE_HEADERS`,
 * which an integration reads and which the root did not carry.
 *
 * Each was invisible in the same way. A consumer hits it as "why can I not
 * import this", the fix is one line, and nothing anywhere fails in the
 * meantime, so the list drifts one symbol at a time and only a person
 * reaching for a missing name ever finds out.
 *
 * **The exclusion list is the part that has to be strict.** A guard whose
 * escape hatch takes a bare name would be silenced rather than satisfied,
 * so an exclusion carries a reason and a symbol that no longer exists fails
 * the check. An enumeration nobody prunes is the thing this exists against;
 * it should not create a second one.
 */

/** A symbol deliberately not on the package root. */
export interface RootExclusion {
  symbol: string;
  /** Why a consumer does not need it. Read by a person, not by code. */
  reason: string;
}

export interface ReachabilityReport {
  /** Exported by a module, absent from the root, not excluded. */
  unreachable: string[];
  /** Excluded but no longer exported by any module. */
  staleExclusions: string[];
}

/**
 * Compare a package's module-level exports against its root.
 *
 * `moduleExports` is the union across every source module; `rootExports` is
 * what the package root offers. Both are name sets — a symbol renamed
 * rather than removed shows up as one of each, which is the honest reading.
 */
export function checkRootReachability(
  moduleExports: readonly string[],
  rootExports: readonly string[],
  exclusions: readonly RootExclusion[],
): ReachabilityReport {
  const root = new Set(rootExports);
  const modules = new Set(moduleExports);
  const excluded = new Set(exclusions.map((e) => e.symbol));

  return {
    unreachable: [...modules]
      .filter((s) => !root.has(s) && !excluded.has(s))
      .sort(),
    staleExclusions: [...excluded].filter((s) => !modules.has(s)).sort(),
  };
}

/**
 * The runtime kit's deliberate exclusions.
 *
 * Kept here rather than in the kit so the kit's own build carries no
 * knowledge of the check, and so adding one is a visible edit to a file
 * about guards rather than a line in the middle of a source module.
 */
export const RUNTIME_SDK_ROOT_EXCLUSIONS: RootExclusion[] = [
  {
    symbol: "InMemoryStorage",
    reason:
      "The kit's own test fake. Authors use @withmarfa/runtime-test's instead; the kit keeps a private copy only because depending on that package would close a workspace cycle.",
  },
  {
    symbol: "createInMemoryStorage",
    reason:
      "Same fake as above, its factory. Publishing it would offer authors a second fake with no reason to prefer it.",
  },
];

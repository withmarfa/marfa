/**
 * A stored mapping is validated once, at save, and the registry it was
 * validated against keeps moving underneath it.
 *
 * Two ordinary operations break a mapping that the system already asserted
 * was valid: deleting its target type, and changing that type so the
 * mapping's coverage no longer holds — a new required field, or the
 * removal of one a rule assigns. Neither is a write to the mapping, so
 * nothing revalidates and every reader goes on assuming the assertion.
 *
 * The failure that follows is the quiet kind. It lands per item, at sync
 * time, on a schedule nobody is watching, as one activity row per record.
 * This module moves the discovery to the moment the invariant breaks.
 *
 * **Reported, not refused.** A type deletion is a space administrator
 * operating on their own registry; a mapping is one person's configuration
 * on a connection. Refusing the deletion would mean an administrator
 * cannot remove their own type until they have searched every connection's
 * settings for a preference somebody else set. A guard on the delete path
 * would also answer only half the question, since adding a required field
 * breaks a mapping with no deletion anywhere in sight.
 */
import {
  type Item,
  type MappingIssue,
  validateConnectionMapping,
} from "@withmarfa/shared";

import type { Storage } from "../storage/interface.js";

/** One page of the connection scan. Spaces hold few connections; this is a
 *  bound rather than a tuning knob. */
const CONNECTION_SCAN_PAGE = 100;

/** How many of a connection's own activity rows the repair path reads back
 *  when looking for breaks to close. Scoped to one connection and one
 *  severity, so this is a generous ceiling rather than a page size. */
const ACTIVITY_SCAN_LIMIT = 200;

/** Marks the rows this module writes, so the repair path can find its own
 *  breaks without matching on summary text. */
export const MAPPING_BROKEN_KIND = "mapping_broken";

export interface BrokenMapping {
  connection_id: string;
  /** The integration whose connection holds the mapping, for a message a
   *  person can act on without opening the connection first. */
  integration_ref: string | null;
  issues: MappingIssue[];
}

/** Every live integration connection in the space, one page at a time. */
async function listIntegrationConnections(
  storage: Storage,
  spaceId: string | undefined,
): Promise<Item[]> {
  const out: Item[] = [];
  let cursor: string | null = null;
  do {
    const page: { data: Item[]; cursor: string | null } =
      await storage.items.list({
        type: "system.connection",
        state: "active",
        limit: CONNECTION_SCAN_PAGE,
        ...(spaceId === undefined ? {} : { spaceId }),
        ...(cursor ? { cursor } : {}),
      });
    for (const connection of page.data) {
      if (connection.properties.kind === "integration") out.push(connection);
    }
    cursor = page.cursor;
  } while (cursor);
  return out;
}

/** The rules of a stored mapping, or an empty list when the connection
 *  carries none. Shape-tolerant on purpose: this reads a document written
 *  by an earlier validation, and a mapping that no longer parses is
 *  exactly what the caller wants to hear about. */
function ruleTargets(connection: Item): string[] {
  const mapping = (connection.properties as { mapping?: unknown }).mapping;
  if (mapping === null || typeof mapping !== "object") return [];
  const rules = (mapping as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) return [];
  return rules
    .map((rule) =>
      rule !== null && typeof rule === "object"
        ? (rule as { target_type?: unknown }).target_type
        : undefined,
    )
    .filter((target): target is string => typeof target === "string");
}

function integrationRefOf(connection: Item): string | null {
  const ref = (connection.properties as { integration_ref?: unknown })
    .integration_ref;
  return typeof ref === "string" ? ref : null;
}

/**
 * Revalidate every mapping in the space that names `typeId`, against the
 * registry as it now stands.
 *
 * Call this **after** the type mutation has landed. The registry the
 * validator reads is kept in step by the type store, so running it first
 * would validate against the world the caller is leaving.
 *
 * The rule scan reads the stored document rather than the registry, so a
 * deleted type is still found by the mapping that names it.
 */
export async function revalidateMappingsForType(
  storage: Storage,
  typeId: string,
  spaceId: string | undefined,
): Promise<BrokenMapping[]> {
  const broken: BrokenMapping[] = [];
  for (const connection of await listIntegrationConnections(storage, spaceId)) {
    if (!ruleTargets(connection).includes(typeId)) continue;
    const mapping = (connection.properties as { mapping?: unknown }).mapping;
    const validated = validateConnectionMapping(mapping, spaceId);
    if (validated.ok) continue;
    broken.push({
      connection_id: connection.id,
      integration_ref: integrationRefOf(connection),
      issues: validated.issues,
    });
  }
  return broken;
}

/**
 * The whole step — revalidate, then report — with the guarantee the caller
 * needs: it never fails the operation it is reporting on.
 *
 * A type change that has already landed is not undone by a failure to
 * describe its consequences, and answering a successful mutation with an
 * error because the commentary on it failed is backwards. The registry can
 * hold state no write path will produce any more, and reading it is enough
 * to throw; one such chain elsewhere in the space must not take down an
 * unrelated update.
 *
 * **`null` is not `[]`.** An empty list means the check ran and found
 * nothing; `null` means it did not run, and the caller is told which. A
 * check that could not run has not established that nothing is broken, and
 * reporting the two the same way is how a silent failure becomes a
 * reassurance.
 */
export async function revalidateAndReport(
  storage: Storage,
  spaceId: string | undefined,
  context: {
    typeId: string;
    change: "deleted" | "updated";
    clientIp?: string | null;
  },
): Promise<BrokenMapping[] | null> {
  try {
    const broken = await revalidateMappingsForType(
      storage,
      context.typeId,
      spaceId,
    );
    await reportBrokenMappings(storage, broken, spaceId, context);
    return broken;
  } catch (err) {
    void storage.audit.log({
      client_ip: context.clientIp ?? null,
      space_id: spaceId ?? null,
      action: "connection.mapping_revalidation_failed",
      resource_type: "type",
      resource_id: context.typeId,
      details: {
        change: context.change,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return null;
  }
}

/**
 * One `action_required` row per broken mapping, carrying the same sentence
 * the save-time refusal would have given: the rule, the field, and why.
 *
 * One row per operation rather than one per operation per existing row.
 * A type change is a deliberate administrative act and each one that
 * leaves a mapping broken is a distinct event worth recording; the reason
 * a scheduled sweep must dedupe — that it repeats forever on its own — does
 * not apply to something a person does by hand.
 *
 * Emission never fails the caller's operation. The type change has already
 * landed and is not undone by a report about it; a failure to write the
 * row goes to audit, where a missing report is at least findable.
 */
export async function reportBrokenMappings(
  storage: Storage,
  broken: BrokenMapping[],
  spaceId: string | undefined,
  context: {
    typeId: string;
    change: "deleted" | "updated";
    clientIp?: string | null;
  },
): Promise<void> {
  for (const entry of broken) {
    try {
      await storage.items.create(
        {
          type: "system.activity",
          properties: {
            severity: "action_required",
            summary: `Mapping no longer valid: "${context.typeId}" was ${context.change}`,
            connection_id: entry.connection_id,
            detail: {
              kind: MAPPING_BROKEN_KIND,
              type_id: context.typeId,
              change: context.change,
              issues: entry.issues,
              ...(entry.integration_ref === null
                ? {}
                : { integration_ref: entry.integration_ref }),
            },
          },
        },
        spaceId,
      );
    } catch (err) {
      void storage.audit.log({
        client_ip: context.clientIp ?? null,
        space_id: spaceId ?? null,
        action: "connection.mapping_break_report_failed",
        resource_type: "system.connection",
        resource_id: entry.connection_id,
        details: {
          type_id: context.typeId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
}

/**
 * Close the breaks a repaired mapping answers.
 *
 * Nothing in the platform closes an `action_required` row today — the
 * Repairs inbox is a filter over a severity, and a row that has been dealt
 * with stays in it until a person removes the item. That is a general gap
 * and not this module's to solve, but a break this module opened it can
 * close, and leaving a permanent complaint about a mapping that now
 * validates would make the inbox less trustworthy the more it is used.
 *
 * The row is downgraded rather than deleted. Severity is the surfacing
 * level by its own definition, so lowering it when the thing stops needing
 * attention is the field doing its job; the summary stays as written,
 * because the break did happen, and `resolved_at` records when it stopped
 * mattering.
 */
export async function closeMappingBreaks(
  storage: Storage,
  connectionId: string,
  spaceId: string | undefined,
): Promise<number> {
  const page = await storage.items.list({
    type: "system.activity",
    limit: ACTIVITY_SCAN_LIMIT,
    filter: `properties.connection_id eq "${connectionId}" AND properties.severity eq "action_required"`,
    ...(spaceId === undefined ? {} : { spaceId }),
  });
  let closed = 0;
  for (const row of page.data) {
    const detail = (row.properties as { detail?: unknown }).detail;
    if (
      detail === null ||
      typeof detail !== "object" ||
      (detail as { kind?: unknown }).kind !== MAPPING_BROKEN_KIND
    ) {
      continue;
    }
    await storage.items.update(
      row.id,
      {
        properties: {
          severity: "info",
          detail: { ...(detail as Record<string, unknown>), resolved: true },
        },
      },
      spaceId,
    );
    closed += 1;
  }
  return closed;
}

import { parseScope } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import { liveAllowedScopes } from "../auth/oauth-provider.js";

/** One item type a person may choose when an app asks for all data. */
export interface ChoosableType {
  id: string;
  /** The type's own singular label, where the registry holds one. */
  label?: string;
}

/** The roots whose types are the platform's own bookkeeping, not the person's data. */
const NOT_DATA = new Set(["system", "marfa"]);

/**
 * The item types a person may choose one by one in place of all data: every
 * type registered here, the core types first and the instance's own after,
 * each group by identifier so a type sits beside its subtypes, except the
 * platform's own (`system.*`, which "all your data" would reach but a person does not keep).
 *
 * `ceiling` is the client's registered scope list. A client with none tracks
 * the live allowlist, so for that client a type outside it is not offered:
 * the provider would refuse the scope.
 */
export async function resolveChoosableTypes(
  storage: Storage,
  ceiling: readonly string[] | null,
): Promise<ChoosableType[]> {
  const allowed = ceiling === null ? new Set(liveAllowedScopes()) : undefined;
  return (await storage.types.list())
    .filter(
      (type) =>
        !NOT_DATA.has(type.id.split(".", 1)[0] ?? "") &&
        (allowed === undefined || allowed.has(`${type.id}:read`)),
    )
    .map((type) => ({ id: type.id, label: type.label }))
    .sort(
      (a, b) =>
        Number(!a.id.startsWith("core.")) - Number(!b.id.startsWith("core.")) ||
        (a.id < b.id ? -1 : 1),
    );
}

/** Whether any of the scopes is the one for all data, at either level. */
export function asksForAllData(scopes: readonly string[]): boolean {
  return scopes.some((literal) => {
    const parsed = parseScope(literal);
    return parsed?.kind === "type" && parsed.typePattern === "*";
  });
}

/**
 * The types a person may choose for a request, or none where the request does
 * not name all data. Both approval pages and both decisions call this, so the
 * list a person chooses from and the list a post is held to are one.
 */
export async function chooseTypesFor(
  storage: Storage,
  clientId: string,
  requested: readonly string[],
): Promise<ChoosableType[]> {
  if (!asksForAllData(requested)) return [];
  const client = await storage.oauthProvider?.getClient(clientId);
  return resolveChoosableTypes(storage, client?.scopes ?? null);
}

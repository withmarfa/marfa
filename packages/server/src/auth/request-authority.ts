import { AsyncLocalStorage } from "node:async_hooks";
import type { Permission } from "@withmarfa/shared";

/** `at` is the moment the sign-in is judged at; unset, it is when the transaction opens. */
export interface RecentSignIn {
  at: number | undefined;
}

interface RequestAuthority {
  permissions: Set<Permission>;
  recent: RecentSignIn | undefined;
  validate: (
    permissions: ReadonlySet<Permission>,
    recent: RecentSignIn | undefined,
  ) => Promise<void>;
}

const requests = new AsyncLocalStorage<RequestAuthority>();
const validating = new AsyncLocalStorage<boolean>();

export function withRequestAuthority<T>(
  validate: RequestAuthority["validate"],
  run: () => Promise<T>,
): Promise<T> {
  return requests.run(
    { permissions: new Set(), recent: undefined, validate },
    run,
  );
}

/**
 * Whether the caller runs inside a request's admission. The server's own work
 * runs outside every one (`runInBackground`).
 */
export function inRequest(): boolean {
  return requests.getStore() !== undefined;
}

export function rememberAuthorityPermission(permission: Permission): void {
  requests.getStore()?.permissions.add(permission);
}

/**
 * A check made with no moment is judged when the transaction opens, and
 * outweighs one that named a moment, so naming one never loosens a check
 * another door made.
 */
export function rememberRecentAuthentication(at?: number): void {
  const request = requests.getStore();
  if (!request) return;
  const held = request.recent;
  request.recent = {
    at:
      at === undefined || (held && held.at === undefined)
        ? undefined
        : Math.max(at, held?.at ?? at),
  };
}

/**
 * Called under the write lock by `storage.runInTransaction`, before its body
 * runs. A revoked credential is refused here, and a narrowed one is read
 * again into the request's context. A door judges the credential as it
 * stands only by reading it from the context inside such a transaction
 * (`requireAuth`): a key read before it opened, or inside a store's own
 * transaction, is the key as it was before the change
 * (`routes/item-write-live-key.test.ts`).
 */
export async function validateRequestAuthority(): Promise<void> {
  const request = requests.getStore();
  if (!request || validating.getStore()) return;
  await validating.run(true, () =>
    request.validate(request.permissions, request.recent),
  );
}

/**
 * Asks again, later, what the request was admitted on, for work that
 * outlives its response's headers: it answers as the next request on the
 * same credential would. A credential that ended is refused `401`, and one
 * that no longer holds what the request needed `403`. A key or token still
 * standing refreshes the context's credential to its stored maps, so what
 * the request reads afterwards is what the credential holds now.
 */
export function recheckRequestAuthority(): () => Promise<void> {
  const request = requests.getStore();
  if (!request) throw new Error("No request authority to ask again");
  return () =>
    validating.run(true, () =>
      request.validate(request.permissions, request.recent),
    );
}

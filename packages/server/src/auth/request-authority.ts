import { AsyncLocalStorage } from "node:async_hooks";
import type { Permission } from "@withmarfa/shared";

interface RequestAuthority {
  permissions: Set<Permission>;
  recent: boolean;
  validate: (
    permissions: ReadonlySet<Permission>,
    recent: boolean,
  ) => Promise<void>;
}

const requests = new AsyncLocalStorage<RequestAuthority>();
const validating = new AsyncLocalStorage<boolean>();

export function withRequestAuthority<T>(
  validate: RequestAuthority["validate"],
  run: () => Promise<T>,
): Promise<T> {
  return requests.run({ permissions: new Set(), recent: false, validate }, run);
}

export function rememberAuthorityPermission(permission: Permission): void {
  requests.getStore()?.permissions.add(permission);
}

export function rememberRecentAuthentication(): void {
  const request = requests.getStore();
  if (request) request.recent = true;
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

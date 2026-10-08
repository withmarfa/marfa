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

/** Called under the write lock; revocation and narrowing cannot race a write. */
export async function validateRequestAuthority(): Promise<void> {
  const request = requests.getStore();
  if (!request || validating.getStore()) return;
  await validating.run(true, () =>
    request.validate(request.permissions, request.recent),
  );
}

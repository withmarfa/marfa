import { isAPIError } from "better-auth/api";
import { withConsentLock } from "./consent-lock.js";
import { revokeProjectedGrant, auditGrantReused } from "./grant-lifecycle.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AuditLogEntry, Storage } from "../storage/interface.js";
import { runAuditedTransaction } from "../storage/audited-transaction.js";

interface CredentialRequest {
  path: string;
  active: boolean;
  failure?: { error: unknown };
  operations: Set<Promise<unknown>>;
  notifications: Set<Promise<void>>;
  clientIp: string | null;
  revoke?: { clientId: string; userId: string };
  phase?: CredentialPersistencePhase;
  registrationScopes?: string[];
  email?: string;
}
export const credentialRequest = new AsyncLocalStorage<CredentialRequest>();

/** Own every provider operation and withhold its answer until persistence settles. */
export async function withCredentialRequest<T>(
  input: Pick<
    CredentialRequest,
    "path" | "clientIp" | "phase" | "registrationScopes" | "email"
  >,
  work: () => Promise<T>,
): Promise<T> {
  const scope: CredentialRequest = {
    ...input,
    active: true,
    operations: new Set(),
    notifications: new Set(),
  };
  return credentialRequest.run(scope, async () => {
    try {
      const result = await work();
      while (scope.operations.size)
        await Promise.allSettled([...scope.operations]);
      if (scope.failure) throw scope.failure.error;
      if (scope.phase)
        await scope.phase.finish(
          result instanceof Response ? result : new Response(null),
        );
      await Promise.all(scope.notifications);
      return result;
    } catch (error) {
      while (scope.operations.size)
        await Promise.allSettled([...scope.operations]);
      const failure = scope.failure ?? { error };
      if (scope.phase) await scope.phase.finish(undefined, failure);
      throw failure.error;
    } finally {
      scope.active = false;
    }
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const activePhase = new AsyncLocalStorage<CredentialPersistencePhase>();

/** A token endpoint authenticates remotely before its first persistence call. */
export class CredentialPersistencePhase {
  private readonly ready =
    deferred<ReturnType<typeof AsyncLocalStorage.snapshot>>();
  private readonly completed = deferred<Response>();
  private pending?: Promise<Response>;
  private closed = false;
  private sealing = false;
  private readonly operations = new Set<Promise<unknown>>();
  private failure?: { error: unknown };
  constructor(
    private readonly storage: Storage,
    private readonly acceptedAction = "auth.token.issued",
  ) {}

  run<T>(write: boolean, work: () => Promise<T>): Promise<T> {
    if (this.closed || (this.sealing && activePhase.getStore() !== this)) {
      return Promise.reject(
        new Error("Credential persistence scope is closed"),
      );
    }
    const operation = this.perform(write, work);
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      (error: unknown) => {
        this.failure ??= { error };
        this.operations.delete(operation);
      },
    );
    return operation;
  }

  private async perform<T>(write: boolean, work: () => Promise<T>): Promise<T> {
    if (activePhase.getStore() === this) return work();
    if (write && !this.pending) {
      const start = () =>
        runAuditedTransaction(
          this.storage,
          () =>
            activePhase.run(this, async () => {
              this.ready.resolve(AsyncLocalStorage.snapshot());
              return this.completed.promise;
            }),
          (response) => ({
            action: response.ok
              ? this.acceptedAction
              : "auth.credentials.refused",
            resource_type: "auth_credentials",
            client_ip: credentialRequest.getStore()?.clientIp ?? null,
          }),
        );
      const pair = credentialRequest.getStore()?.revoke;
      this.pending = pair
        ? withConsentLock(pair.clientId, pair.userId, start)
        : start();
      void this.pending.catch((error: unknown) => {
        this.ready.reject(error);
      });
    }
    if (!this.pending) return work();
    const dispatch = await this.ready.promise;
    return dispatch(work);
  }

  async finish(
    response?: Response,
    failure?: { error: unknown },
  ): Promise<Response> {
    this.sealing = true;
    while (this.operations.size) await Promise.allSettled([...this.operations]);
    if (response && response.status >= 500)
      failure ??= {
        error: new Error("Credential provider failed during persistence"),
      };
    if (this.pending) {
      const rejected = this.failure ?? failure;
      if (rejected) this.completed.reject(rejected.error);
      else if (response) this.completed.resolve(response);
      else
        this.completed.reject(
          new Error("Credential operation produced no response"),
        );
      try {
        return await this.pending;
      } finally {
        this.closed = true;
      }
    }
    this.closed = true;
    const rejected = this.failure ?? failure;
    if (rejected) throw rejected.error;
    if (!response) throw new Error("Credential operation produced no response");
    return response;
  }
}

interface AdapterArgs {
  model: string;
  data?: Record<string, unknown>;
  update?: Record<string, unknown>;
  where?: unknown[];
}
type Operation = (args: AdapterArgs) => Promise<unknown>;
type Adapter = Record<string, unknown> & {
  findOne: Operation;
  findMany: Operation;
  transaction: <T>(body: (adapter: Adapter) => Promise<T>) => Promise<T>;
};

const mutations = [
  "create",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "consumeOne",
  "incrementOne",
] as const;

/** The facade is retained by both captured plugin adapters and provider transaction adapters. */
export function withCredentialAudit<
  Factory extends (options: never) => unknown,
>(factory: Factory, storage: Storage): Factory {
  return ((options: never) => {
    const adapter = factory(options) as Adapter;
    const wrapped: Adapter = { ...adapter };
    for (const operation of mutations) {
      const original = adapter[operation];
      if (typeof original !== "function") continue;
      wrapped[operation] = async (args: AdapterArgs) => {
        let previous: unknown;
        const request = credentialRequest.getStore();
        if (request && !request.active)
          throw new Error("Credential request is closed");
        if (
          operation === "create" &&
          args.model === "oauthClient" &&
          request?.registrationScopes &&
          args.data
        ) {
          args = {
            ...args,
            data: { ...args.data, scopes: request.registrationScopes },
          };
        }
        const revoke = request?.revoke;
        const commit = () =>
          runAuditedTransaction(
            storage,
            async () => {
              if (operation === "delete")
                previous = await adapter.findOne(args);
              const matched =
                revoke &&
                ["oauthAccessToken", "oauthRefreshToken"].includes(args.model)
                  ? ((await adapter.findMany(args)) as Record<
                      string,
                      unknown
                    >[])
                  : [];
              const result = await (original as Operation)(args);
              if (
                revoke &&
                matched.some(
                  (row) =>
                    row.clientId === revoke.clientId &&
                    row.userId === revoke.userId,
                ) &&
                result !== null &&
                result !== 0
              ) {
                const provider = storage.oauthProvider;
                const itemId =
                  (await provider?.findGrantItemId({
                    clientId: revoke.clientId,
                    authUserId: revoke.userId,
                  })) ?? null;
                const item = itemId ? await storage.items.get(itemId) : null;
                await revokeProjectedGrant(storage, {
                  itemId: item?.id ?? null,
                  clientId: revoke.clientId,
                  authUserId: revoke.userId,
                  audit: {
                    action: "auth.grant.revoked",
                    resource_type: "oauth_grant",
                    resource_id: revoke.clientId,
                    client_ip: request.clientIp,
                    details: {
                      client_id: revoke.clientId,
                      user_id: revoke.userId,
                      grant_item_id: item?.id ?? null,
                      source: "client",
                    },
                  },
                });
                request.revoke = undefined;
              }
              if (
                request?.path === "/oauth2/authorize" &&
                args.model === "verification" &&
                operation === "create" &&
                typeof args.data?.identifier === "string"
              ) {
                const grant =
                  await storage.oauthProvider?.findAuthorizationCodeGrantKey(
                    args.data.identifier,
                  );
                if (grant?.hasConsent) {
                  await auditGrantReused(storage, {
                    authUserId: grant.userId,
                    clientId: grant.clientId,
                    scopes: (() => {
                      const value = JSON.parse(String(args.data.value)) as {
                        query?: { scope?: string };
                      };
                      return [
                        ...new Set(
                          value.query?.scope?.split(" ").filter(Boolean) ?? [],
                        ),
                      ];
                    })(),
                    clientIp: request.clientIp,
                  });
                }
              }
              return result;
            },
            (result) => {
              if (
                result === null ||
                result === 0 ||
                (operation === "delete" && !previous)
              )
                return null;
              const request = credentialRequest.getStore();
              const row = (
                result && typeof result === "object" ? result : previous
              ) as Record<string, unknown> | undefined;
              const entry: AuditLogEntry = {
                action: `auth.${args.model}.${operation}`,
                resource_type: `auth_${args.model}`,
                // Verification identifiers can contain credential material. Record only the model there.
                ...(args.model !== "verification" && typeof row?.id === "string"
                  ? { resource_id: row.id }
                  : {}),
                client_ip: request?.clientIp ?? null,
                details: {
                  operation,
                  ...(typeof result === "number" ? { count: result } : {}),
                  ...(typeof row?.userId === "string"
                    ? { user_id: row.userId }
                    : {}),
                  ...(typeof row?.clientId === "string"
                    ? { client_id: row.clientId }
                    : {}),
                },
              };
              if (
                args.model === "session" &&
                operation === "create" &&
                request?.path === "/sign-in/email"
              ) {
                entry.action = "auth.sign_in.success";
                entry.resource_type = "auth_user";
                entry.resource_id = request.email;
                entry.details = { method: "password", email: request.email };
              }
              return entry;
            },
          );
        const pair = revoke;
        const run = () =>
          pair ? withConsentLock(pair.clientId, pair.userId, commit) : commit();
        try {
          return await (request?.phase
            ? request.phase.run(
                request.path !== "/change-password" || args.model === "account",
                run,
              )
            : run());
        } catch (error) {
          if (request) request.failure ??= { error };
          throw error;
        }
      };
    }
    for (const read of ["findOne", "findMany", "count"] as const) {
      const original = adapter[read];
      if (typeof original !== "function") continue;
      wrapped[read] = (args: AdapterArgs) => {
        const request = credentialRequest.getStore();
        if (request && !request.active)
          return Promise.reject(new Error("Credential request is closed"));
        const work = () => (original as Operation)(args);
        return request?.phase?.run(false, work) ?? work();
      };
    }
    // The normal storage writer installs the connection, registry frame and commit hooks.
    // Returning the facade also retains consent idempotence inside provider transactions.
    wrapped.transaction = (body) => {
      const request = credentialRequest.getStore();
      if (request && !request.active)
        return Promise.reject(new Error("Credential request is closed"));
      const work = () =>
        runAuditedTransaction(storage, () => body(wrapped), {
          action: "auth.credentials.changed",
          resource_type: "auth_credentials",
          client_ip: credentialRequest.getStore()?.clientIp ?? null,
        });
      return credentialRequest.getStore()?.phase?.run(true, work) ?? work();
    };
    for (const method of [
      ...mutations,
      "findOne",
      "findMany",
      "count",
      "transaction",
    ]) {
      const original = wrapped[method];
      if (typeof original !== "function") continue;
      const invoke = original as (...args: unknown[]) => unknown;
      wrapped[method] = (...args: unknown[]) => {
        const request = credentialRequest.getStore();
        if (request && !request.active)
          return Promise.reject(new Error("Credential request is closed"));
        const pending = Promise.resolve().then(() =>
          invoke.apply(wrapped, args),
        );
        request?.operations.add(pending);
        void pending.then(
          () => request?.operations.delete(pending),
          (error: unknown) => {
            if (request) {
              if (
                method !== "transaction" ||
                !isAPIError(error) ||
                error.status === "INTERNAL_SERVER_ERROR"
              )
                request.failure ??= { error };
              request.operations.delete(pending);
            }
          },
        );
        return pending;
      };
    }
    return wrapped;
  }) as Factory;
}

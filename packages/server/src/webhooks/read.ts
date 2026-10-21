import { appRecordName, keySignInName } from "../auth/sign-in-names.js";
import type { Context } from "hono";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import {
  isDirectAuthority,
  requireAuth,
  type AppEnv,
} from "../middleware/auth.js";
import type {
  Storage,
  StoredWebhook,
  WebhookOwner,
} from "../storage/interface.js";

export function isWebhookMaker(
  c: Context<AppEnv>,
  owner: WebhookOwner,
): boolean {
  const key = requireAuth(c);
  if (c.get("authType") !== "oauth")
    return owner.kind === "key" && owner.keyId === key.id;
  const grant = c.get("oauthGrant");
  return (
    owner.kind === "grant" &&
    owner.clientId === grant?.clientId &&
    owner.authUserId === grant.authUserId
  );
}

export async function readableWebhook(
  storage: Storage,
  c: Context<AppEnv>,
  id: string,
): Promise<StoredWebhook> {
  const webhook = await storage.outboundWebhooks.get(id);
  if (webhook && (isDirectAuthority(c) || isWebhookMaker(c, webhook.owner)))
    return webhook;
  throw new MarfaError(ErrorCode.WEBHOOK_NOT_FOUND, "Webhook not found");
}

export async function listReadableWebhooks(
  storage: Storage,
  c: Context<AppEnv>,
): Promise<StoredWebhook[]> {
  if (!isDirectAuthority(c)) requireAuth(c);
  return (await storage.outboundWebhooks.list()).filter(
    (w) => isDirectAuthority(c) || isWebhookMaker(c, w.owner),
  );
}

export async function webhookMaker(storage: Storage, owner: WebhookOwner) {
  if (owner.kind === "key") {
    const key = await storage.keys.get(owner.keyId);
    return {
      kind: "key" as const,
      id: owner.keyId,
      name: key ? keySignInName(key.label, key.id) : null,
    };
  }
  const grantId = await storage.oauthProvider?.findGrantItemId({
    clientId: owner.clientId,
    authUserId: owner.authUserId,
  });
  const grant = grantId ? await storage.items.get(grantId) : null;
  return {
    kind: "app" as const,
    id: owner.clientId,
    name: grant
      ? await appRecordName(storage, grant)
      : ((await storage.oauthProvider?.getClient(owner.clientId))?.name ??
        null),
  };
}

export async function readWebhookDeliveries(
  storage: Storage,
  c: Context<AppEnv>,
  id: string,
  page: { limit: number; cursor?: string },
) {
  await readableWebhook(storage, c, id);
  return storage.outboundWebhookDeliveries.list(id, page);
}

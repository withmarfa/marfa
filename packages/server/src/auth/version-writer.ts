import { VERSION_WRITER_KINDS } from "@withmarfa/shared";
import type { ApiKey, Item, VersionWriter } from "@withmarfa/shared";
import type { Context } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import { oauthGrantOf } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import {
  appRecordName,
  browserSignInName,
  keySignInName,
  SIGN_IN_NAME_MAX,
  usableSignInName,
} from "./sign-in-names.js";

/**
 * Who a write is written by, before it is named: a sign-in already named, a
 * credential named when the write lands, or null for the server's own work.
 */
export type WrittenBy =
  VersionWriter | { kind: "credential"; key: ApiKey } | null;

/** The private local command, of which there is one. */
export const LOCAL_WRITER: VersionWriter = {
  kind: "local",
  id: "local",
  name: "Local command",
};

/** The owner's browser session `sessionId`, named from the `User-Agent` it
 *  signed in with, as the sign-in listing names it. */
export function browserWriter(
  sessionId: string,
  userAgent: string | null,
): VersionWriter {
  return {
    kind: "browser",
    id: sessionId,
    name: browserSignInName(userAgent),
  };
}

/**
 * A credential's writer: a key or an app by the id and name the sign-in
 * listing shows it under.
 */
async function credentialWriter(
  storage: Storage,
  key: ApiKey,
): Promise<VersionWriter> {
  const grant = oauthGrantOf(key);
  if (grant === null) {
    return { kind: "key", id: key.id, name: keySignInName(key.label, key.id) };
  }
  const recordId = await storage.oauthProvider?.findGrantItemId(grant);
  const record = recordId ? await storage.items.get(recordId) : null;
  if (!record) {
    // A token is minted only under a grant, whose record stays until long
    // after its tokens are gone.
    throw new Error(
      `The app ${grant.clientId} wrote with no record of its grant`,
    );
  }
  return appWriter(storage, record);
}

/** The app whose grant `record` is, named as the sign-in listing names it. */
export async function appWriter(
  storage: Pick<Storage, "oauthProvider">,
  record: Item,
): Promise<VersionWriter> {
  return {
    kind: "app",
    id: record.id,
    name: await appRecordName(storage, record),
  };
}

const named = new WeakMap<ApiKey, Promise<VersionWriter>>();

/** The sign-in `by` names, named. A credential is named once per request
 *  object, so a bulk write names it once for all its rows. */
export function resolveWriter(
  storage: Storage,
  by: WrittenBy,
): Promise<VersionWriter | null> {
  if (by === null) return Promise.resolve(null);
  if (by.kind !== "credential") return Promise.resolve(by);
  let writer = named.get(by.key);
  if (writer === undefined) {
    writer = credentialWriter(storage, by.key);
    named.set(by.key, writer);
    writer.catch(() => named.delete(by.key));
  }
  return writer;
}

/** The sign-in a request is made by: the owner's browser session, the
 *  local command, or the key or app its bearer token is. */
export function requestWriter(c: Context<AppEnv>): WrittenBy {
  const authority = c.get("authority");
  if (authority?.kind === "local_process") return LOCAL_WRITER;
  if (authority?.kind === "owner")
    return browserWriter(authority.sessionId, authority.userAgent);
  const key = c.get("apiKey");
  return key === undefined ? null : { kind: "credential", key };
}

/**
 * The writer an archive names at `path`: null where it names none, or a
 * description of what is wrong with it.
 */
export function archivedWriter(
  value: unknown,
  path: string,
): { writer: VersionWriter | null } | { field: string; expected: string } {
  if (value === undefined || value === null) return { writer: null };
  if (typeof value !== "object" || Array.isArray(value))
    return { field: path, expected: "null or an object" };
  const { kind, id, name } = value as Record<string, unknown>;
  if (
    typeof kind !== "string" ||
    !(VERSION_WRITER_KINDS as readonly string[]).includes(kind)
  )
    return {
      field: `${path}.kind`,
      expected: VERSION_WRITER_KINDS.join(", "),
    };
  if (typeof id !== "string" || id === "" || id.length > SIGN_IN_NAME_MAX)
    return {
      field: `${path}.id`,
      expected: `a string of 1 to ${String(SIGN_IN_NAME_MAX)} characters`,
    };
  if (typeof name !== "string" || usableSignInName(name) !== name)
    return {
      field: `${path}.name`,
      expected: `a name a sign-in can be shown by: 1 to ${String(SIGN_IN_NAME_MAX)} characters, none unprintable, and no spaces at either end`,
    };
  return {
    writer: { kind: kind as VersionWriter["kind"], id, name },
  };
}

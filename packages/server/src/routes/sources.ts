import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  ErrorCode,
  MarfaError,
  iconNameIssue,
  resolveEnforcement,
} from "@withmarfa/shared";
import { UNPRINTABLE } from "../auth/hidden-characters.js";
import { SIGN_IN_NAME_MAX, usableSignInName } from "../auth/sign-in-names.js";
import type { AppEnv } from "../middleware/auth.js";
import {
  authorityId,
  computeTypeFilter,
  holdsPermission,
  isDirectAuthority,
  oauthGrantOfSource,
  requireAuth,
  requirePermission,
} from "../middleware/auth.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import type { SourceNaming, Storage } from "../storage/interface.js";
import { wholeListOf } from "./_schemas.js";

/** The longest source code a key can hold, which a query has to carry. */
const SOURCE_CODE_MAX = 200;

const NAME_FROM = ["set", "app", "key", "code"] as const;
type NameFrom = (typeof NAME_FROM)[number];

interface SourceView {
  source: string;
  name: string;
  name_from: NameFrom;
  mark?: string;
}

export const SourceSchema = z
  .object({
    source: z
      .string()
      .describe("The source code, as items carry it in `source`.")
      .openapi({ example: "github" }),
    name: z
      .string()
      .describe("The name to show for the source.")
      .openapi({ example: "GitHub" }),
    name_from: z
      .enum(NAME_FROM)
      .describe(
        "Where `name` comes from: `set` on the source, the `app` signed in under it, the label of the `key` that holds it, or the `code` itself.",
      ),
    mark: z
      .string()
      .optional()
      .describe(
        "The icon ID set for the source, from the same sets as a type's `icon`. Absent until someone sets one.",
      )
      .openapi({ example: "simple-icons:github" }),
  })
  .openapi("Source", {
    description: "A source code with the name and mark it's shown by.",
  });

const SourceCodeQuery = z.object({
  source: z
    .string()
    .min(1)
    .max(SOURCE_CODE_MAX)
    .refine((code) => code === code.trim(), {
      message: "source can't start or end with a space",
    })
    .describe(
      "The source code. It's a query parameter because a code such as `..` or one holding `/` can't travel safely in a path.",
    )
    .openapi({ example: "github" }),
});

const NameField = z
  .string()
  .trim()
  .min(1)
  .max(SIGN_IN_NAME_MAX)
  .refine((name) => !UNPRINTABLE.test(name), {
    message: "name can't hold a control or bidirectional formatting character",
  });

const UpdateSourceBody = z.strictObject({
  name: NameField.nullable()
    .optional()
    .describe(
      "The name to show for the source, or `null` to clear it. Marfa trims spaces from each end.",
    )
    .openapi({ example: "GitHub" }),
  mark: z
    .string()
    .nullable()
    .optional()
    .describe(
      "An icon ID from the same sets as a type's `icon`, or `null` to clear it.",
    )
    .openapi({ example: "simple-icons:github" }),
});

const badCode = {
  content: {
    "application/json": {
      schema: makeErrorResponseSchema([
        "missing_required_field",
        "validation_error",
      ]),
    },
  },
  description:
    "- `missing_required_field`: `source` is missing.\n- `validation_error`: `source` isn't 1 to 200 characters or starts or ends with a space, or the query has a parameter this endpoint doesn't take.",
};

const unauthorized = {
  content: {
    "application/json": { schema: makeErrorResponseSchema(["unauthorized"]) },
  },
  description: "Unauthorized",
};

const notFound = {
  content: {
    "application/json": {
      schema: makeErrorResponseSchema(["source_not_found"]),
    },
  },
  description:
    "`source_not_found`: the source isn't your own or one you claim, and no item you can read carries it.",
};

const listSourcesRoute = createRoute({
  operationId: "listSources",
  method: "get",
  path: "/sources",
  tags: ["Sources"],
  summary: "List sources",
  description:
    "Returns the sources you can see, each with its name and mark: your own, those you claim, and those of items you can read. `keys.manage` and the owner see every source in use or named.",
  security: [{ bearerAuth: [] }, { ownerSession: [] }] as Record<
    string,
    string[]
  >[],
  request: { query: z.object({}) },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: wholeListOf(SourceSchema, "SourcePage", "source"),
        },
      },
      description: "Returns every source you can see, ordered by code.",
    },
    401: unauthorized,
  },
});

const getSourceRoute = createRoute({
  operationId: "getSource",
  method: "get",
  path: "/source",
  tags: ["Sources"],
  summary: "Get a source",
  description:
    "Returns a source's name and mark. A source needs no item or key to be read, but you see only your own, those you claim and those of items you can read, unless you hold `keys.manage`.",
  security: [{ bearerAuth: [] }, { ownerSession: [] }] as Record<
    string,
    string[]
  >[],
  request: { query: SourceCodeQuery },
  responses: {
    200: {
      content: { "application/json": { schema: SourceSchema } },
      description: "Returns the source.",
    },
    400: badCode,
    401: unauthorized,
    404: notFound,
  },
});

const updateSourceRoute = createRoute({
  operationId: "updateSource",
  method: "patch",
  path: "/source",
  tags: ["Sources"],
  summary: "Name a source",
  description:
    "Sets or clears a source's name and mark, and returns the source. A field left out keeps its value. You can change your own source and those you claim; any other needs `keys.manage`.",
  security: [{ bearerAuth: [] }, { ownerSession: [] }] as Record<
    string,
    string[]
  >[],
  request: {
    query: SourceCodeQuery,
    body: {
      required: true,
      content: { "application/json": { schema: UpdateSourceBody } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: SourceSchema } },
      description: "Returns the source as it now reads.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "missing_required_field",
            "validation_error",
            "invalid_schema",
          ]),
        },
      },
      description:
        "- `missing_required_field`: `source` is missing.\n- `validation_error`: `source` isn't 1 to 200 characters or starts or ends with a space, `name` is empty, too long or holds a control character, the body has a field this endpoint doesn't take, or the query has a parameter it doesn't take.\n- `invalid_schema`: `mark` isn't the ID of an icon in a pinned set (`details.errors` names it).",
    },
    401: unauthorized,
    403: {
      content: {
        "application/json": { schema: makeErrorResponseSchema(["forbidden"]) },
      },
      description:
        "`forbidden`: the source isn't your own or one you claim, and you don't hold `keys.manage` (`details.required_scope`).",
    },
  },
});

function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether the caller sees every source: the owner, the local command, or a
 *  credential holding `keys.manage`, which already sees every key. */
function seesEverySource(c: Context<AppEnv>): boolean {
  return isDirectAuthority(c) || holdsPermission(c, "keys.manage");
}

function ownedSources(c: Context<AppEnv>): Set<string> {
  if (isDirectAuthority(c)) return new Set();
  const key = requireAuth(c);
  return new Set([key.source, ...(key.sources ?? [])]);
}

/** The sources of the items the caller can read, in any state, or of only
 *  `source` when it names one. */
async function readableItemSources(
  c: Context<AppEnv>,
  storage: Storage,
  source?: string,
): Promise<string[]> {
  const key = isDirectAuthority(c) ? undefined : requireAuth(c);
  const reach = computeTypeFilter(key);
  if (reach.allowed?.length === 0) return [];
  const enforcement = resolveEnforcement(
    await readInstanceConfig(storage.settings),
    key,
  );
  const counts = await storage.items.stats(
    {
      all_states: true,
      source,
      source_filter: enforcement.source_filter,
      readable_sources: reach,
      allowed_types: reach.allowed,
      excluded_types: reach.excluded,
    },
    "source",
  );
  return Object.keys(counts);
}

async function appName(
  storage: Storage,
  source: string,
): Promise<string | undefined> {
  const grant = oauthGrantOfSource(source);
  if (!grant) return undefined;
  const recordId = await storage.oauthProvider?.findGrantItemId(grant);
  const record = recordId ? await storage.items.get(recordId) : null;
  const ownName = record?.properties.name;
  const client = await storage.oauthProvider?.getClient(grant.clientId);
  return (
    usableSignInName(typeof ownName === "string" ? ownName : undefined) ??
    usableSignInName(client?.name)
  );
}

/**
 * A source's name and mark. The name is the one set on the source, then the
 * name of the app signed in under it, then the label of the live key whose
 * own source it is, then the code. A claimed source takes no key's label:
 * the key that claims it is not what it names.
 */
async function sourceView(
  storage: Storage,
  source: string,
  row: SourceNaming | undefined,
  labels: ReadonlyMap<string, string>,
): Promise<SourceView> {
  const mark = row?.mark ?? undefined;
  const view = (name: string, name_from: NameFrom): SourceView => ({
    source,
    name,
    name_from,
    ...(mark === undefined ? {} : { mark }),
  });
  if (row?.name != null) return view(row.name, "set");
  const app = await appName(storage, source);
  if (app !== undefined) return view(app, "app");
  const label = usableSignInName(labels.get(source));
  if (label !== undefined) return view(label, "key");
  return view(source, "code");
}

async function sourceViews(
  storage: Storage,
  codes: Iterable<string>,
  named?: ReadonlyMap<string, SourceNaming>,
): Promise<SourceView[]> {
  const rows =
    named ??
    new Map((await storage.sources.list()).map((row) => [row.source, row]));
  const labels = await storage.keys.ownSourceLabels();
  const views: SourceView[] = [];
  for (const source of [...new Set(codes)].sort(byCode)) {
    views.push(await sourceView(storage, source, rows.get(source), labels));
  }
  return views;
}

async function oneSourceView(
  storage: Storage,
  source: string,
): Promise<SourceView> {
  return sourceView(
    storage,
    source,
    (await storage.sources.get(source)) ?? undefined,
    await storage.keys.ownSourceLabels(),
  );
}

export function sourceRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(listSourcesRoute, async (c) => {
    const data = await storage.runInReadSnapshot(
      async () => {
        const rows = new Map(
          (await storage.sources.list()).map((row) => [row.source, row]),
        );
        const codes = new Set(await readableItemSources(c, storage));
        if (seesEverySource(c)) {
          for (const code of rows.keys()) codes.add(code);
          for (const code of (await storage.keys.ownSourceLabels()).keys())
            codes.add(code);
        } else {
          for (const code of ownedSources(c)) codes.add(code);
        }
        return sourceViews(storage, codes, rows);
      },
      { signal: c.req.raw.signal },
    );
    return c.json({ data, next_cursor: null }, 200);
  });

  router.openapi(getSourceRoute, async (c) => {
    const { source } = c.req.valid("query");
    const view = await storage.runInReadSnapshot(
      async () => {
        const visible =
          seesEverySource(c) ||
          ownedSources(c).has(source) ||
          (await readableItemSources(c, storage, source)).length > 0;
        if (!visible) return null;
        return oneSourceView(storage, source);
      },
      { signal: c.req.raw.signal },
    );
    if (!view) {
      throw new MarfaError(
        ErrorCode.SOURCE_NOT_FOUND,
        "You can't see a source with this code",
      );
    }
    return c.json(view, 200);
  });

  router.openapi(updateSourceRoute, async (c) => {
    const { source } = c.req.valid("query");
    const body = c.req.valid("json");
    if (!ownedSources(c).has(source)) requirePermission(c, "keys.manage");
    if (typeof body.mark === "string") {
      const refused = iconNameIssue(body.mark, "mark");
      if (refused) {
        throw new MarfaError(ErrorCode.INVALID_SCHEMA, "Invalid source mark", {
          errors: [refused],
        });
      }
    }
    const view = await runAuditedTransaction(
      storage,
      async () => {
        const held = await storage.sources.get(source);
        const name = body.name === undefined ? (held?.name ?? null) : body.name;
        const mark = body.mark === undefined ? (held?.mark ?? null) : body.mark;
        await storage.sources.set(source, name, mark);
        return oneSourceView(storage, source);
      },
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: authorityId(c),
        action: "source.update",
        resource_type: "source",
        resource_id: source,
      },
    );
    return c.json(view, 200);
  });

  return router;
}

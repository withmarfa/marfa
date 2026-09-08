/**
 * Integration registry.
 *
 * Persists Integration manifests as `system.integration` items so that:
 *   - `system.connection.integration.integration_ref` resolves
 *     to a stable item id at runtime (replacing the older inline-manifest
 *     path in routes/inbound-webhooks.ts and routes/connection-leased-tokens.ts).
 *   - The install pipeline (this file's GET/POST /integrations/:id/install)
 *     can mint a connection bound to a specific manifest version.
 *
 * Sibling-per-version model — registering the same manifest_name at a new
 * manifest_version creates a new sibling item rather than mutating the
 * existing one. Connections installed against v1.0 keep pointing at the
 * v1.0 item even after v1.1 lands; upgrade is an explicit caller concern.
 *
 * Registration is platform-credential gated (is_platform: true) — the
 * marketplace publisher (or the orchestrator's CLI) is the legitimate
 * caller. Listing/get is admin-or-platform.
 */
import { Hono } from "hono";
import { MAX_PAGE_LIMIT } from "../page-limits.js";
import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { ConfigurationFieldSpec } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { MarfaAuth } from "../auth/instance.js";
import { resolveSpaceAdminCaller } from "./_space-caller.js";
import { validateManifest } from "../integrations/validate-manifest.js";
import { validateManifestAuthoring } from "@withmarfa/shared";
import { registerIntegrationManifest } from "../integrations/register-manifest.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import {
  INSTALL_CONFIG_FIELD_PREFIX,
  renderInstallConsentScreen,
} from "./integration-install-page.js";
import { parseGenericConfigurePayload } from "./connection-configure.js";
import { performInstall } from "../connections/install-pipeline.js";
import { publish } from "../pubsub.js";
import { renderAuthLayout } from "./auth-layout.js";
import { confirmIcon } from "./auth-html.js";

// Manifest is stored as opaque on the wire — `validateManifest()` runs
// the structured Zod check at the route handler.
const RegisterIntegrationRequestSchema = z.object({
  manifest: z.record(z.string(), z.unknown()),
});

const IntegrationItemSchema = z.object({
  id: z.string(),
  manifest_name: z.string(),
  manifest_version: z.string(),
  /**
   * The name a person reads, from the manifest.
   *
   * Lifted to the top level rather than left inside `manifest` because a
   * catalog renders one line per integration and should not have to open a
   * whole manifest to find out what to call it. Optional because a manifest
   * may omit it, in which case the identifier is what there is.
   */
  display_name: z.string().optional(),
  publisher: z.string(),
  summary: z.string().optional(),
  direction: z.enum(["read", "write", "both"]),
  registered_at: z.string(),
  /**
   * How many connections this space already holds for this integration, by
   * name rather than by version.
   *
   * A count rather than a boolean, and by name rather than by manifest id,
   * because both of the obvious simplifications say something false. Some
   * integrations are installed more than once on purpose — one connection
   * per feed — so "installed: true" hides the shape of what is there. And a
   * space holding version 1 while version 2 is the newest would read as not
   * installed if the count were per manifest row, which is the question a
   * catalog is least interested in.
   */
  installed_count: z.number().int().nonnegative(),
  manifest: z.record(z.string(), z.unknown()),
});

const IntegrationListResponseSchema = z.object({
  data: z.array(IntegrationItemSchema),
});

const registerRoute = createRoute({
  operationId: "registerIntegration",
  method: "post",
  path: "/",
  tags: ["Integrations"],
  summary: "Register an integration manifest",
  description:
    "Registers an integration manifest as a `system.integration` item, validating it before the write. One row per `(manifest_name, manifest_version)` pair — registering a new version creates a sibling item rather than editing the existing one.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: RegisterIntegrationRequestSchema },
      },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: IntegrationItemSchema } },
      description:
        "Integration registered. Subsequent versions register as sibling items.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
          ]),
        },
      },
      description: "Validation error (manifest schema rejection)",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Caller lacks is_platform: true",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["conflict"]),
        },
      },
      description: "manifest_name + manifest_version already registered",
    },
  },
});

const listRoute = createRoute({
  operationId: "listIntegrations",
  method: "get",
  path: "/",
  tags: ["Integrations"],
  summary: "List integrations",
  description:
    "Returns every registered integration manifest, with the number of connections this space already holds for each. Pass `latest=true` for the catalog view, one row per integration. Filter by `manifest_name` to enumerate the registered versions of one integration.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      manifest_name: z
        .string()
        .optional()
        .describe("Filter to versions of a single integration by name."),
      latest: z
        .enum(["true", "false"])
        .optional()
        .describe(
          "Return only the newest registered version of each integration. This is what a catalog wants; the default returns every version, which is what enumerating one integration's history wants.",
        ),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_LIMIT)
        .optional()
        .describe("Maximum number of integrations to return."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: IntegrationListResponseSchema },
      },
      description: "List of registered Integrations",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
  },
});

const getRoute = createRoute({
  operationId: "getIntegration",
  method: "get",
  path: "/{id}",
  tags: ["Integrations"],
  summary: "Get an integration",
  description:
    "Returns one integration manifest by id, including the full manifest body. Use as the source-of-truth payload at install time so the consent screen renders the actual scopes being approved.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().min(1).describe("Id of the integration to fetch."),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: IntegrationItemSchema } },
      description: "The Integration item",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["integration_not_found"]),
        },
      },
      description: "Not found",
    },
  },
});

interface IntegrationProperties {
  manifest_name: string;
  manifest_version: string;
  publisher: string;
  summary?: string;
  direction: "read" | "write" | "both";
  manifest: Record<string, unknown>;
  registered_at: string;
}

function toResponse(
  item: {
    id: string;
    properties: Record<string, unknown>;
  },
  installedCount = 0,
): z.infer<typeof IntegrationItemSchema> {
  const props = item.properties as unknown as IntegrationProperties;
  const displayName = props.manifest.display_name;
  return {
    id: item.id,
    manifest_name: props.manifest_name,
    manifest_version: props.manifest_version,
    display_name: typeof displayName === "string" ? displayName : undefined,
    publisher: props.publisher,
    summary: props.summary,
    direction: props.direction,
    registered_at: props.registered_at,
    installed_count: installedCount,
    manifest: props.manifest,
  };
}

/**
 * The two manifest fields the catalog reduction reads off a stored row.
 *
 * A stored row is `Record<string, unknown>`, so every read needs a cast, and
 * doing it at each use spreads one assumption over six places. Both return
 * the empty string for a row that does not carry the field: such a row is
 * excluded from the reduction rather than crashing it.
 */
function manifestNameOf(item: { properties: Record<string, unknown> }): string {
  const name = item.properties.manifest_name;
  return typeof name === "string" ? name : "";
}

function manifestVersionOf(item: {
  properties: Record<string, unknown>;
}): string {
  const version = item.properties.manifest_version;
  return typeof version === "string" ? version : "";
}

/**
 * Orders two manifest versions, newest first.
 *
 * Local rather than shared: one caller, and promoting it would widen a
 * published package's surface for the benefit of nothing else.
 *
 * A string sort is what this replaces, and it is wrong in the ordinary case
 * rather than an edge one: lexically `"10.0.0" < "9.0.0"`, so an
 * integration's tenth release would quietly stop being the one a catalog
 * offers. Nothing about the response would say why.
 *
 * No pre-release handling, because the manifest schema refuses one — a
 * version is `MAJOR.MINOR.PATCH` and nothing else. The unparseable branch
 * is not the same thing and is reachable: this reads a version out of a
 * stored row, and nothing re-validates a stored manifest against the
 * schema at read time. Such a row sorts last rather than throwing, so one
 * malformed manifest cannot decide what the whole catalog offers.
 */
function newestFirst(a: string, b: string): number {
  const parse = (v: string): [number, number, number] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    return match === null
      ? null
      : [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const left = parse(a);
  const right = parse(b);
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  for (let i = 0; i < 3; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return r - l;
  }
  return 0;
}

/**
 * How many connections this space holds for each integration, by name.
 *
 * A connection records the manifest *item* it was installed against, not
 * the integration's name, so the refs are resolved back to names here. That
 * indirection is the reason this is a function rather than a filter: the
 * question a catalog asks is about the integration, and the connection only
 * answers a question about the version.
 *
 * A revoked connection does not count. It is a grant that has been given up
 * rather than one that is running, and offering "install" for something the
 * space is still holding a dead grant for is the more useful answer.
 */
async function installedCountsByName(
  storage: Storage,
  spaceId: string | undefined,
): Promise<Map<string, number>> {
  const connections = await storage.items.list({
    spaceId,
    type: "system.connection",
    filter: 'properties.kind eq "integration"',
    limit: 500,
  });

  const refs = new Set<string>();
  const live: string[] = [];
  for (const connection of connections.data) {
    const props = connection.properties as {
      integration_ref?: unknown;
      status?: unknown;
    };
    if (props.status === "revoked") continue;
    if (typeof props.integration_ref !== "string") continue;
    refs.add(props.integration_ref);
    live.push(props.integration_ref);
  }
  if (refs.size === 0) return new Map();

  // Platform-scoped manifests carry no space id, so the same widening the
  // read routes use is needed here or every count comes back zero on a
  // deployment whose integrations all ship with the platform.
  const manifests = await storage.items.getMany([...refs], spaceId);
  const platformScoped = [...refs].filter((ref) => !manifests.has(ref));
  for (const ref of platformScoped) {
    const item = await storage.items.get(ref, spaceId, {
      includePlatformScoped: true,
    });
    if (item !== null) manifests.set(ref, item);
  }

  const counts = new Map<string, number>();
  for (const ref of live) {
    const manifest = manifests.get(ref);
    if (manifest === undefined) continue;
    const name = manifestNameOf(manifest);
    if (name === "") continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

export function integrationRoutes(storage: Storage, auth?: MarfaAuth) {
  // Split: apiRouter (OpenAPI JSON CRUD) and htmlRouter (HTML install flow, plain Hono).
  // Mixing the two on one OpenAPIHono instance was observed to misroute bodies in tests.
  const apiRouter = createOpenAPIRouter<AppEnv>();
  const htmlRouter = new Hono<AppEnv>();

  apiRouter.openapi(registerRoute, async (c) => {
    const apiKey = requireAuth(c);
    if (!apiKey.is_platform) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        "Integration registration requires a platform credential (is_platform: true)",
      );
    }

    const body = c.req.valid("json");
    const result = validateManifest(body.manifest);
    if (!result.ok) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Manifest validation failed",
        { errors: result.errors },
      );
    }
    const manifest = result.manifest;

    // The authoring door. This route judges a manifest somebody is writing
    // now, never a row somebody installed against earlier, so it can hold
    // the stricter half: a field with nothing to say is absent. The boot
    // reconcile deliberately does not call this — it registers what the
    // image already staged, which may predate the rule, and refusing there
    // would take the catalog down rather than telling an author anything.
    const authoringIssues = validateManifestAuthoring(manifest);
    if (authoringIssues.length > 0) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Manifest validation failed",
        {
          errors: authoringIssues.map((message) => ({
            path: "_root",
            message,
          })),
        },
      );
    }

    const outcome = await registerIntegrationManifest(
      storage,
      manifest,
      apiKey.space_id,
    );
    if (outcome.status === "already_present") {
      throw new MarfaError(
        ErrorCode.CONFLICT,
        `Integration ${manifest.name}@${manifest.version} is already registered`,
        {
          manifest_name: manifest.name,
          manifest_version: manifest.version,
        },
      );
    }
    const item = outcome.item;

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: apiKey.id,
      action: "integration.register",
      resource_type: "item",
      resource_id: item.id,
      details: {
        manifest_name: manifest.name,
        manifest_version: manifest.version,
      },
    });

    return c.json(toResponse(item), 201);
  });

  apiRouter.openapi(listRoute, async (c) => {
    const apiKey = requireAuth(c);
    const query = c.req.valid("query");
    const filter = query.manifest_name
      ? `properties.manifest_name eq "${query.manifest_name}"`
      : undefined;
    // Platform-scoped manifests (space_id IS NULL) are invisible to in-space callers without this flag.
    // The limit is applied after the newest-per-integration reduction, not
    // by the query, because the two mean different things: a caller asking
    // for ten integrations would otherwise get however many of ten rows
    // survived the reduction, which on a registry holding several versions
    // of one integration can be one.
    const items = await storage.items.list({
      spaceId: apiKey.space_id,
      includePlatformScoped: true,
      type: "system.integration",
      filter,
      limit: query.latest === "true" ? 500 : (query.limit ?? 50),
    });

    let rows = items.data;
    if (query.latest === "true") {
      const newest = new Map<string, (typeof rows)[number]>();
      for (const item of rows) {
        const name = manifestNameOf(item);
        if (name === "") continue;
        const held = newest.get(name);
        if (
          held === undefined ||
          newestFirst(manifestVersionOf(item), manifestVersionOf(held)) < 0
        ) {
          newest.set(name, item);
        }
      }
      rows = [...newest.values()]
        .sort((a, b) => {
          const an = manifestNameOf(a);
          const bn = manifestNameOf(b);
          return an < bn ? -1 : an > bn ? 1 : 0;
        })
        .slice(0, query.limit ?? 50);
    }

    const counts = await installedCountsByName(storage, apiKey.space_id);
    return c.json(
      {
        data: rows.map((i) =>
          toResponse(i, counts.get(manifestNameOf(i)) ?? 0),
        ),
      },
      200,
    );
  });

  apiRouter.openapi(getRoute, async (c) => {
    const apiKey = requireAuth(c);
    const id = c.req.valid("param").id;
    // Platform-scoped manifests (space_id IS NULL) — widen so space members can resolve them.
    const item = await storage.items.get(id, apiKey.space_id, {
      includePlatformScoped: true,
    });
    if (item?.type !== "system.integration") {
      throw new MarfaError(
        ErrorCode.INTEGRATION_NOT_FOUND,
        "Integration not found",
      );
    }
    const counts = await installedCountsByName(storage, apiKey.space_id);
    return c.json(toResponse(item, counts.get(manifestNameOf(item)) ?? 0), 200);
  });

  // ---------------------------------------------------------------------
  // Install pipeline — separate from the registry routes so the consent
  // surface (HTML) stays distinct from the registry CRUD surface (JSON).
  //
  // The install routes are NOT openapi-registered — they're plain Hono
  // routes returning HTML. This mirrors the precedent set by the OAuth
  // consent flow (routes/consent.ts) which also stays out of the
  // OpenAPI surface because the response is an HTML form, not JSON.
  //
  // Dual auth path (browser session OR Bearer): the install consent
  // screen is designed for human navigation, so a BetterAuth session
  // cookie is sufficient. Operator / test / CLI callers still go via a
  // Bearer-resolved api_key. The rule lives in `_space-caller.ts`,
  // shared with the configuration surface one step further along the
  // same flow.
  // ---------------------------------------------------------------------

  htmlRouter.get("/:id/install", async (c) => {
    const caller = await resolveSpaceAdminCaller(
      c,
      storage,
      auth,
      "Space admin authority required to install an integration",
      "capability.connections",
    );
    if (caller instanceof Response) return caller;
    const id = c.req.param("id");
    const item = await storage.items.get(id, caller.spaceId, {
      includePlatformScoped: true,
    });
    if (item?.type !== "system.integration") {
      throw new MarfaError(
        ErrorCode.INTEGRATION_NOT_FOUND,
        "Integration not found",
      );
    }
    const props = item.properties as unknown as IntegrationProperties;

    // ?credential_ref= pre-arm: validate the credential before rendering so the
    // operator gets a clean 4xx rather than a deep install failure.
    const credentialRefParam = c.req.query("credential_ref");
    let credentialRefHint: string | undefined;
    let credentialRefLabel: string | undefined;
    if (credentialRefParam !== undefined && credentialRefParam.length > 0) {
      const cred = await storage.items.get(credentialRefParam, caller.spaceId);
      if (cred?.type !== "system.credential") {
        throw new MarfaError(
          ErrorCode.INVALID_REQUEST,
          `credential_ref ${credentialRefParam} does not resolve to a system.credential item in this space`,
          { credential_ref: credentialRefParam },
        );
      }
      const credProps = cred.properties as { kind?: string; label?: string };
      if (credProps.kind !== "oauth_token") {
        throw new MarfaError(
          ErrorCode.INVALID_REQUEST,
          `credential_ref ${credentialRefParam} resolves to a system.credential of kind '${String(credProps.kind)}'; expected 'oauth_token'`,
          { credential_ref: credentialRefParam, kind: credProps.kind },
        );
      }
      credentialRefHint = cred.id;
      credentialRefLabel = credProps.label ?? cred.id;
    }

    const html = renderInstallConsentScreen({
      integrationId: id,
      manifestName: props.manifest_name,
      manifestVersion: props.manifest_version,
      publisher: props.publisher,
      summary: props.summary ?? "",
      direction: props.direction,
      manifest: props.manifest,
      ...(credentialRefHint !== undefined ? { credentialRefHint } : {}),
      ...(credentialRefLabel !== undefined ? { credentialRefLabel } : {}),
    });
    return c.html(html);
  });

  htmlRouter.post("/:id/install", async (c) => {
    const caller = await resolveSpaceAdminCaller(
      c,
      storage,
      auth,
      "Space admin authority required to install an integration",
      "capability.connections",
    );
    if (caller instanceof Response) return caller;
    const id = c.req.param("id");
    const item = await storage.items.get(id, caller.spaceId, {
      includePlatformScoped: true,
    });
    if (item?.type !== "system.integration") {
      throw new MarfaError(
        ErrorCode.INTEGRATION_NOT_FOUND,
        "Integration not found",
      );
    }
    const props = item.properties as unknown as IntegrationProperties;

    const formData = await c.req.parseBody();
    const decision = formData.decision;
    const credentialRefOverride =
      typeof formData.credential_ref === "string" &&
      formData.credential_ref.length > 0
        ? formData.credential_ref
        : undefined;

    if (decision !== "approve") {
      return c.html(renderInstallDeniedPage());
    }

    // The form's configuration fields carry a prefix so a manifest key can
    // never collide with `decision` / `credential_ref`; strip it and
    // coerce the strings back to the declared types.
    const manifestShape = props.manifest as {
      configuration_schema?: Record<string, ConfigurationFieldSpec>;
    };
    const configForm = Object.fromEntries(
      Object.entries(formData)
        .filter(([key]) => key.startsWith(INSTALL_CONFIG_FIELD_PREFIX))
        .map(([key, value]) => [
          key.slice(INSTALL_CONFIG_FIELD_PREFIX.length),
          value,
        ]),
    );
    const configuration = parseGenericConfigurePayload(
      configForm,
      manifestShape.configuration_schema ?? {},
    );

    let installed;
    try {
      installed = await performInstall(storage, {
        apiKeyId: caller.apiKeyId,
        spaceId: caller.spaceId,
        authMode: c.get("config").authMode,
        clientIp: c.get("clientIp") ?? null,
        integrationItemId: id,
        manifest: props.manifest,
        configuration,
        ...(credentialRefOverride !== undefined
          ? { credentialRef: credentialRefOverride }
          : {}),
      });
    } catch (err) {
      // A configuration the contract refuses re-renders the form with the
      // refusal and the user's values intact — behind the Install button a
      // bare 400 is a dead end with nothing to correct.
      if (
        err instanceof MarfaError &&
        err.code === ErrorCode.VALIDATION_ERROR
      ) {
        const issues = (
          err.details as
            { issues?: { key: string; message: string }[] } | undefined
        )?.issues;
        const message = issues?.length
          ? issues.map((i) => i.message).join(". ")
          : err.message;
        return c.html(
          renderInstallConsentScreen({
            integrationId: id,
            manifestName: props.manifest_name,
            manifestVersion: props.manifest_version,
            publisher: props.publisher,
            summary: props.summary ?? "",
            direction: props.direction,
            manifest: props.manifest,
            configurationValues: configuration,
            errorMessage: message,
            ...(credentialRefOverride !== undefined
              ? { credentialRefHint: credentialRefOverride }
              : {}),
          }),
          400,
        );
      }
      throw err;
    }

    // Same pubsub publish as the JSON install route — the bridge needs it to discover new connections.
    const connection = await storage.items.get(
      installed.connection_id,
      caller.spaceId ?? undefined,
    );
    if (connection) {
      const metadata = await storage.metadata.get(connection.id);
      await publish({
        type: "created",
        item: connection,
        metadata,
        spaceId: caller.spaceId ?? undefined,
      });
    }

    return c.html(renderInstalledPage());
  });

  apiRouter.route("/", htmlRouter);

  return apiRouter;
}

/**
 * The two terminals of the integration install flow.
 *
 * Both used to emit a bare document with a few rules of inline CSS and a
 * privately re-implemented HTML escape — the only surfaces the server hands
 * a person that carried no design at all. A person who declined an install
 * met unstyled Times New Roman immediately after a fully designed consent
 * screen, which reads as a different product having broken.
 */
export function renderInstallDeniedPage(): string {
  return renderAuthLayout({
    title: "Install declined",
    centered: true,
    bodyHtml: `
      ${confirmIcon("check")}
      <h1 class="title">Install declined</h1>
      <p class="sub" role="status">Nothing was connected and nothing was changed. You can close this tab.</p>
    `,
  });
}

export function renderInstalledPage(): string {
  return renderAuthLayout({
    title: "Connection installed",
    centered: true,
    bodyHtml: `
      ${confirmIcon("check")}
      <h1 class="title">Connection installed</h1>
      <p class="sub" role="status">It is ready to run. You can close this tab.</p>
    `,
  });
}

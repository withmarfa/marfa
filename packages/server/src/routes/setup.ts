import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "@hono/zod-openapi";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { InstanceConfig } from "@withmarfa/shared";
import type { MarfaAuth } from "../auth/instance.js";
import type { Storage } from "../storage/interface.js";
import type { AppEnv } from "../middleware/auth.js";
import {
  claimOwner,
  exchangeSetupCode,
  exchangeSetupTicket,
  getClaimStatus,
  hasSetupSession,
  requireOwnerSession,
} from "../auth/instance-claim.js";
import {
  requireOwnerOrigin,
  requireSecureOwnerTransport,
} from "../auth/owner-browser.js";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
import {
  readInstanceConfig,
  writeInstanceConfig,
} from "../storage/instance-config.js";
import { InstanceNameSchema, readInstanceName } from "../instance-name.js";
import { SETUP_WORDS, tooManyTries } from "../pages/setup-words.js";
import { ownerSessionCookies, isBrowserClaim } from "./claim-session.js";
import { ownerWire } from "./owner-wire.js";
import { contentSecurityPolicy } from "./content-security-policy.js";
import { setNoStore } from "./no-store.js";
import { refuseUnknownBodyKeys } from "./_unknown-body-keys.js";
import {
  OWNER_STEPS,
  SETUP_STEP_PATHS,
  renderBackupsPage,
  renderClaimedPage,
  renderCodePage,
  renderConnectPage,
  renderDetailsPage,
  renderNamePage,
  renderPasskeyPage,
  type DetailsPageState,
  type OwnerStep,
} from "./setup-pages.js";

export const SETUP_COOKIE = "marfa.setup";

/**
 * The fields the two setup doors read from a JSON body. The doors are not in
 * the published document, so these are the only declaration of them, and
 * they are what an undeclared key is judged against.
 */
const ExchangeBody = z.object({ ticket: z.string(), code: z.string() });
const ClaimBody = z.object({
  email: z.string(),
  password: z.string(),
  name: z.string(),
  code: z.string(),
});
/** What the setup page's name form sends. */
const NameForm = z.object({ name: z.string() });
/** What the setup page's code form sends. */
const ExchangeForm = z.object({ code: z.string() });

const FORM_TYPES = ["application/x-www-form-urlencoded", "multipart/form-data"];
const isForm = (c: Context<AppEnv>): boolean => {
  const type = c.req.header("content-type")?.toLowerCase() ?? "";
  return FORM_TYPES.some((form) => type.startsWith(form));
};

const NAME_REFUSAL =
  "That name can't be used. Use 200 characters or fewer, with no control characters.";

export function setupRoutes(storage: Storage, auth: MarfaAuth) {
  const router = new Hono<AppEnv>();
  const page = (
    c: Context<AppEnv>,
    html: string,
    status: 200 | 400 | 401 | 409 | 429 = 200,
  ) => {
    c.header(
      "Content-Security-Policy",
      `${contentSecurityPolicy(c.var.cspNonce)}; connect-src 'self'; form-action 'self'`,
    );
    return c.html(html, status);
  };
  const claimedPage = async (c: Context<AppEnv>, status: 200 | 409 = 200) =>
    page(
      c,
      renderClaimedPage(
        c.var.cspNonce,
        await readInstanceName(storage.settings),
      ),
      status,
    );
  const setSetupCookie = (c: Context<AppEnv>, token: string): void => {
    setCookie(c, SETUP_COOKIE, token, {
      httpOnly: true,
      secure: auth.baseURL.startsWith("https:"),
      sameSite: "Strict",
      path: "/",
      maxAge: 15 * 60,
    });
  };

  router.use("*", async (c, next) => {
    setNoStore(c);
    requireSecureOwnerTransport(auth);
    // Not `no-referrer`: that makes a browser send `Origin: null` on the
    // forms' own posts, which the origin check refuses.
    c.header("Referrer-Policy", "same-origin");
    await next();
  });

  router.get("/", async (c) => {
    if ((await getClaimStatus(storage)).claimed) return claimedPage(c);
    const setupReady =
      c.req.query("step") !== "code" &&
      (await hasSetupSession(storage, getCookie(c, SETUP_COOKIE) ?? ""));
    return page(
      c,
      setupReady
        ? renderDetailsPage(c.var.cspNonce)
        : renderCodePage(c.var.cspNonce),
    );
  });

  router.post("/exchange", async (c) => {
    requireOwnerOrigin(auth, c.req.raw.headers);
    const address = c.get("clientIp") ?? null;
    if (isForm(c)) {
      const body = await c.req.parseBody();
      refuseUnknownBodyKeys(body, ExchangeForm);
      const code = typeof body.code === "string" ? body.code : "";
      if (code.trim() === "")
        return page(
          c,
          renderCodePage(c.var.cspNonce, { codeError: SETUP_WORDS.noCode }),
          400,
        );
      try {
        const session = await exchangeSetupCode(storage, code, address);
        setSetupCookie(c, session.token);
        return c.redirect("/setup", 303);
      } catch (error) {
        if (!(error instanceof MarfaError)) throw error;
        if (error.code === ErrorCode.OWNER_EXISTS) return claimedPage(c, 409);
        if (error.code === ErrorCode.RATE_LIMITED)
          return page(
            c,
            renderCodePage(c.var.cspNonce, {
              codeError: tooManyTries(retryAfter(error)),
            }),
            429,
          );
        if (error.code === ErrorCode.SETUP_PROOF_INVALID)
          return page(
            c,
            renderCodePage(c.var.cspNonce, {
              codeError: SETUP_WORDS.wrongCode,
            }),
            401,
          );
        throw error;
      }
    }
    const body = await c.req.json<{ ticket?: unknown; code?: unknown }>();
    refuseUnknownBodyKeys(body, ExchangeBody);
    const session =
      typeof body.ticket === "string"
        ? await exchangeSetupTicket(storage, body.ticket)
        : typeof body.code === "string"
          ? await exchangeSetupCode(storage, body.code, address)
          : null;
    if (!session)
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Enter a setup code or open a new setup link.",
      );
    setSetupCookie(c, session.token);
    return c.json({ ready: true });
  });

  // The HTML form fallback shares the claim operation with the JSON owner API.
  router.post("/claim", async (c) => {
    requireOwnerOrigin(auth, c.req.raw.headers, { allowNonBrowser: true });
    const json = c.req.header("content-type")?.includes("application/json");
    const body = json
      ? await c.req.json<Record<string, string>>()
      : await c.req.parseBody<Record<string, string>>();
    refuseUnknownBodyKeys(body, ClaimBody);
    const token = getCookie(c, SETUP_COOKIE);
    const form = !json && isBrowserClaim(auth, c.req.raw.headers);
    let owner;
    try {
      owner = await claimOwner(storage, auth, {
        email: body.email ?? "",
        password: body.password ?? "",
        name: body.name,
        proof:
          typeof body.code === "string"
            ? {
                kind: "code",
                code: body.code,
                address: c.get("clientIp") ?? null,
              }
            : { kind: "session", token: token ?? "" },
      });
    } catch (error) {
      if (!form || !(error instanceof MarfaError)) throw error;
      return refusedClaim(c, error, body);
    }
    deleteCookie(c, SETUP_COOKIE, { path: "/" });
    for (const cookie of await ownerSessionCookies(
      c,
      auth,
      owner,
      body.password ?? "",
    ))
      c.header("set-cookie", cookie, { append: true });
    return form
      ? c.redirect(SETUP_STEP_PATHS.passkey, 303)
      : c.json(ownerWire(owner), 201);
  });

  /** A claim the page's own form made and the server refused, answered as the page again. */
  function refusedClaim(
    c: Context<AppEnv>,
    error: MarfaError,
    body: Record<string, string>,
  ): Response | Promise<Response> {
    const nonce = c.var.cspNonce;
    if (error.code === ErrorCode.OWNER_EXISTS) return claimedPage(c, 409);
    if (error.code === ErrorCode.SETUP_PROOF_INVALID)
      return page(
        c,
        renderCodePage(nonce, { notice: SETUP_WORDS.sessionEnded }),
        401,
      );
    const state: DetailsPageState = { email: body.email, name: body.name };
    if (error.code === ErrorCode.RATE_LIMITED)
      return page(
        c,
        renderDetailsPage(nonce, {
          ...state,
          notice: tooManyTries(retryAfter(error)),
        }),
        429,
      );
    if (error.code !== ErrorCode.VALIDATION_ERROR) throw error;
    const errors: NonNullable<DetailsPageState["errors"]> = {};
    for (const entry of fieldErrors(error)) {
      if (
        entry.path === "email" ||
        entry.path === "name" ||
        entry.path === "password"
      )
        errors[entry.path] ??= entry.message;
    }
    return page(
      c,
      renderDetailsPage(nonce, {
        ...state,
        errors,
        ...(Object.keys(errors).length === 0 ? { notice: error.message } : {}),
      }),
      400,
    );
  }

  /** The owner's own steps, after the claim. Without a session there is no step to show. */
  async function ownerStepGate(
    c: Context<AppEnv>,
    returnTo: string,
  ): Promise<Response | null> {
    try {
      await requireOwnerSession(storage, auth, c.req.raw.headers);
      return null;
    } catch (error) {
      if (
        !(error instanceof MarfaError) ||
        error.code !== ErrorCode.UNAUTHORIZED
      )
        throw error;
      if (!(await getClaimStatus(storage)).claimed) return c.redirect("/setup");
      return c.redirect(
        `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`,
      );
    }
  }

  router.get("/:step", async (c) => {
    const step = c.req.param("step") as OwnerStep;
    if (!OWNER_STEPS.includes(step))
      throw new MarfaError(ErrorCode.NOT_FOUND, "Not found");
    const gate = await ownerStepGate(c, SETUP_STEP_PATHS[step]);
    if (gate) return gate;
    const nonce = c.var.cspNonce;
    switch (step) {
      case "passkey":
        return page(c, renderPasskeyPage(nonce));
      case "name":
        return page(
          c,
          renderNamePage(nonce, {
            name: await readInstanceName(storage.settings),
          }),
        );
      case "connect":
        return page(c, renderConnectPage(nonce, new URL(auth.baseURL).origin));
      case "backups":
        return page(
          c,
          renderBackupsPage(nonce, { bucket: c.var.config.s3Bucket !== "" }),
        );
    }
  });

  router.post("/name", async (c) => {
    requireOwnerOrigin(auth, c.req.raw.headers);
    const session = await requireOwnerSession(storage, auth, c.req.raw.headers);
    if (!isForm(c))
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Send the name as a form.",
      );
    const body = await c.req.parseBody();
    refuseUnknownBodyKeys(body, NameForm);
    const raw = typeof body.name === "string" ? body.name : "";
    const blank = raw.trim() === "";
    const parsed = blank ? null : InstanceNameSchema.safeParse(raw);
    if (parsed && !parsed.success)
      return page(
        c,
        renderNamePage(c.var.cspNonce, { name: raw, error: NAME_REFUSAL }),
        400,
      );
    // The name is one setting among several in a record that is written whole,
    // so the others are read and kept in the same step that writes it.
    await runAuditedTransaction(
      storage,
      async () => {
        const kept: InstanceConfig = {
          ...(await readInstanceConfig(storage.settings)),
        };
        delete kept.name;
        await writeInstanceConfig(storage.settings, {
          ...kept,
          ...(parsed?.success ? { name: parsed.data } : {}),
        });
      },
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: `owner:${session.session.id}`,
        action: "config.update",
        resource_type: "config",
      },
    );
    return c.redirect(SETUP_STEP_PATHS.connect, 303);
  });

  return router;
}

function retryAfter(error: MarfaError): number | undefined {
  const value = error.details?.retry_after;
  return typeof value === "number" ? value : undefined;
}

function fieldErrors(error: MarfaError): { path: string; message: string }[] {
  const entries = error.details?.errors;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { path, message } = entry as Record<string, unknown>;
    return typeof path === "string" && typeof message === "string"
      ? [{ path, message }]
      : [];
  });
}

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { OwnerRecord, Storage } from "../storage/interface.js";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
import type { MarfaAuth, MarfaAuthSession } from "./instance.js";
import { KeyedThrottle } from "./keyed-throttle.js";
import { addressBucket } from "../middleware/client-ip.js";
import { PasswordAttemptsSpent, passwordAttempts } from "./sign-in-throttle.js";

export const CLAIM_STATE_KEY = "instance.claim";
const SESSION_MS = 15 * 60_000;
const TICKET_MS = 5 * 60_000;
interface Proof {
  digest: string;
  expiresAt: number;
}
interface ClaimState {
  claimed: boolean;
  ownerId: string | null;
  generation: string | null;
  codeDigest: string | null;
  tickets: Proof[];
  sessions: Proof[];
}
const emptyState = (): ClaimState => ({
  claimed: false,
  ownerId: null,
  generation: null,
  codeDigest: null,
  tickets: [],
  sessions: [],
});
async function read(storage: Storage): Promise<ClaimState> {
  const raw = await storage.settings.get(CLAIM_STATE_KEY);
  return raw === null ? emptyState() : (JSON.parse(raw) as ClaimState);
}
async function write(storage: Storage, state: ClaimState): Promise<void> {
  const now = Date.now();
  state.tickets = state.tickets.filter((p) => p.expiresAt > now);
  state.sessions = state.sessions.filter((p) => p.expiresAt > now);
  await storage.settings.set(CLAIM_STATE_KEY, JSON.stringify(state));
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function matches(value: string, expected: string | null): boolean {
  return (
    expected !== null &&
    timingSafeEqual(
      Buffer.from(digest(value), "hex"),
      Buffer.from(expected, "hex"),
    )
  );
}
function unclaimed(state: ClaimState): void {
  if (state.claimed)
    throw new MarfaError(
      ErrorCode.OWNER_EXISTS,
      "This instance has already been claimed.",
    );
}
function invalidProof(): never {
  throw new MarfaError(
    ErrorCode.UNAUTHORIZED,
    "Setup proof is invalid, expired, or replaced. Obtain a new setup code or link.",
  );
}
function normalizedCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}
function generateCode(): string {
  const bytes = randomBytes(16);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let acc = 0,
    bits = 0,
    result = "";
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet.charAt((acc >>> bits) & 31);
    }
  }
  if (bits) result += alphabet.charAt((acc << (5 - bits)) & 31);
  return (result.match(/.{1,5}/g) ?? []).join("-");
}
export async function getClaimStatus(storage: Storage) {
  const { claimed, ownerId, generation } = await read(storage);
  return { claimed, ownerId, generation };
}
/** Local-process operation. Each unclaimed startup replaces the shared generation. */
export async function issueSetupCode(
  storage: Storage,
): Promise<{ code: string; generation: string }> {
  const code = generateCode(),
    generation = randomBytes(16).toString("hex");
  return runAuditedTransaction(
    storage,
    async () => {
      const state = await read(storage);
      unclaimed(state);
      await write(storage, {
        ...state,
        generation,
        codeDigest: digest(normalizedCode(code)),
        tickets: [],
        sessions: [],
      });
      return { code, generation };
    },
    { action: "instance.setup_code.issued", resource_type: "instance" },
  );
}
export async function issueSetupTicket(
  storage: Storage,
): Promise<{ ticket: string; expiresAt: number }> {
  const ticket = randomBytes(32).toString("base64url"),
    expiresAt = Date.now() + TICKET_MS;
  return runAuditedTransaction(
    storage,
    async () => {
      const state = await read(storage);
      unclaimed(state);
      // Local authority may open setup before a startup code is requested.
      state.generation ??= randomBytes(16).toString("hex");
      state.tickets.push({ digest: digest(ticket), expiresAt });
      await write(storage, state);
      return { ticket, expiresAt };
    },
    { action: "instance.setup_ticket.issued", resource_type: "instance" },
  );
}
async function countCodeAttempt(
  storage: Storage,
  address: string | null,
): Promise<void> {
  const throttle = new KeyedThrottle(storage, {
    family: "instance-claim-address",
    limit: 10,
    windowMs: SESSION_MS,
  });
  const result = await throttle.attempt(
    address ? addressBucket(address) : "unknown",
  );
  if (!result.allowed)
    throw new MarfaError(
      ErrorCode.RATE_LIMITED,
      "Too many setup code attempts. Try again later.",
      {
        retry_after: Math.max(
          1,
          Math.ceil((result.resetAt - Date.now()) / 1000),
        ),
      },
    );
}
async function newSession(storage: Storage, state: ClaimState) {
  const token = randomBytes(32).toString("base64url"),
    expiresAt = Date.now() + SESSION_MS;
  state.sessions.push({ digest: digest(token), expiresAt });
  await write(storage, state);
  return { token, expiresAt };
}
export async function exchangeSetupTicket(storage: Storage, ticket: string) {
  return runAuditedTransaction(
    storage,
    async () => {
      const state = await read(storage);
      unclaimed(state);
      const index = state.tickets.findIndex(
        (p) => p.expiresAt > Date.now() && matches(ticket, p.digest),
      );
      if (index < 0) invalidProof();
      state.tickets.splice(index, 1);
      return newSession(storage, state);
    },
    { action: "instance.setup_ticket.exchanged", resource_type: "instance" },
  );
}
export async function hasSetupSession(
  storage: Storage,
  token: string,
): Promise<boolean> {
  const state = await read(storage);
  return (
    !state.claimed &&
    state.sessions.some(
      (p) => p.expiresAt > Date.now() && matches(token, p.digest),
    )
  );
}

export async function exchangeSetupCode(
  storage: Storage,
  code: string,
  address: string | null,
) {
  await countCodeAttempt(storage, address);
  return runAuditedTransaction(
    storage,
    async () => {
      const state = await read(storage);
      unclaimed(state);
      if (!matches(normalizedCode(code), state.codeDigest)) invalidProof();
      return newSession(storage, state);
    },
    {
      action: "instance.setup_code.exchanged",
      resource_type: "instance",
      client_ip: address,
    },
  );
}
export type ClaimProof =
  | { kind: "local" }
  | { kind: "code"; code: string; address: string | null }
  | { kind: "session"; token: string };
export const ownerDetailsSchema = z.object({
  email: z.email().max(254),
  password: z.string(),
  name: z.string().trim().max(200).optional(),
});
function validateClaimProof(state: ClaimState, proof: ClaimProof): void {
  unclaimed(state);
  if (
    proof.kind === "code" &&
    !matches(normalizedCode(proof.code), state.codeDigest)
  )
    invalidProof();
  if (
    proof.kind === "session" &&
    !state.sessions.some(
      (p) => p.expiresAt > Date.now() && matches(proof.token, p.digest),
    )
  )
    invalidProof();
}
export async function claimOwner(
  storage: Storage,
  auth: MarfaAuth,
  input: { email: string; password: string; name?: string; proof: ClaimProof },
): Promise<OwnerRecord> {
  const parsed = ownerDetailsSchema.safeParse(input);
  if (!parsed.success)
    throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid owner details.");
  const { proof } = input;
  if (proof.kind === "code") await countCodeAttempt(storage, proof.address);
  validateClaimProof(await read(storage), proof);
  const prepared = await auth.preparePassword(parsed.data.password);
  return runAuditedTransaction(
    storage,
    async () => {
      const state = await read(storage);
      validateClaimProof(state, proof);
      const result = await auth.createEmailAccount(
        parsed.data,
        undefined,
        prepared,
      );
      if (!result.ok) {
        if (result.reason === "email_exists")
          throw new MarfaError(
            ErrorCode.OWNER_EXISTS,
            "This instance already has an owner.",
          );
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          result.reason === "password_too_short"
            ? `Password must be at least ${String(result.minLength)} characters.`
            : `Password must be at most ${String(result.maxLength)} characters.`,
        );
      }
      await write(storage, {
        claimed: true,
        ownerId: result.authUserId,
        generation: null,
        codeDigest: null,
        tickets: [],
        sessions: [],
      });
      return {
        id: result.authUserId,
        email: result.email,
        name: result.name,
        createdAt: result.createdAt,
      };
    },
    (owner) => ({
      action: "owner.claimed",
      resource_type: "owner",
      resource_id: owner.id,
      client_ip: proof.kind === "code" ? proof.address : null,
    }),
  );
}
export async function requireOwnerSession(
  storage: Storage,
  auth: MarfaAuth,
  headers: Headers,
  options: { recent?: boolean } = {},
): Promise<MarfaAuthSession> {
  // A browser cookie must never add owner authority to a bearer request.
  if (headers.has("authorization"))
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      "Use your direct owner sign-in for this operation.",
    );
  const session = await auth.getSession(headers, { readOnly: true }),
    state = await getClaimStatus(storage);
  if (!session || !state.claimed || session.user.id !== state.ownerId)
    throw new MarfaError(
      ErrorCode.UNAUTHORIZED,
      "Sign in as the owner to continue.",
    );
  const authenticatedAt = new Date(session.session.createdAt).getTime();
  if (
    options.recent &&
    (!Number.isFinite(authenticatedAt) ||
      authenticatedAt > Date.now() ||
      Date.now() - authenticatedAt > 5 * 60_000)
  )
    throw new MarfaError(
      ErrorCode.UNAUTHORIZED,
      "Sign in again to continue. This operation needs authentication within five minutes.",
    );
  return session;
}
export async function recoverOwnerPassword(
  storage: Storage,
  auth: MarfaAuth,
  input: { password: string },
): Promise<void> {
  const prepared = await auth.preparePassword(input.password);
  await runAuditedTransaction(
    storage,
    async () => {
      const state = await getClaimStatus(storage),
        owner = await storage.owner?.find();
      if (!state.claimed || owner?.id !== state.ownerId)
        throw new MarfaError(
          ErrorCode.OWNER_NOT_FOUND,
          "The claimed owner's account is unavailable.",
        );
      await auth.resetEmailPassword(owner.id, prepared);
      await storage.rateLimits.clearSignIn(owner.email);
    },
    { action: "owner.password.recovered", resource_type: "owner" },
  );
}
/**
 * The owner's password change. The current password is a password check like
 * a sign-in, so it is counted against the sign-in windows before it is judged,
 * and each refusal is recorded as a failed sign-in is.
 */
export async function changeOwnerPassword(
  storage: Storage,
  auth: MarfaAuth,
  headers: Headers,
  input: {
    currentPassword: string;
    password: string;
    clientAddress: string | null;
  },
): Promise<void> {
  const initial = await requireOwnerSession(storage, auth, headers);
  const refused = (reason: "too_many_attempts" | "invalid_credentials") =>
    runAuditedTransaction(storage, () => undefined, {
      action: "owner.password.change_failed",
      resource_type: "owner",
      resource_id: initial.user.id,
      client_ip: input.clientAddress,
      details: { reason },
    });
  const admitted = await passwordAttempts(storage)(
    initial.user.email,
    input.clientAddress,
  );
  if (!admitted.allowed) {
    await refused("too_many_attempts");
    throw new PasswordAttemptsSpent(admitted.retryAfter);
  }
  let prepared: Awaited<ReturnType<MarfaAuth["preparePasswordChange"]>>;
  try {
    prepared = await auth.preparePasswordChange(
      initial.user.id,
      input.currentPassword,
      input.password,
    );
  } catch (error) {
    if (error instanceof MarfaError && error.code === ErrorCode.UNAUTHORIZED)
      await refused("invalid_credentials");
    throw error;
  }
  // Recheck the live session and previously verified password digest under the
  // writer lock, so a recovery racing with slow password work wins safely.
  await runAuditedTransaction(
    storage,
    async () => {
      const session = await requireOwnerSession(storage, auth, headers);
      await auth.resetEmailPassword(
        session.user.id,
        prepared,
        session.session.id,
      );
      await storage.rateLimits.clearSignIn(session.user.email);
    },
    { action: "owner.password.changed", resource_type: "owner" },
  );
}

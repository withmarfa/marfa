/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * The claim and setup screens: one sequence of six steps, from the setup code
 * to backups, each a moment card with a step indicator.
 *
 * Steps 1 and 2 are the person's claim of an unclaimed instance, and run
 * before anyone is signed in. Steps 3 to 6 are the owner's, reached after the
 * claim has signed them in.
 *
 * Every form posts to the server and works without a script. The script moves
 * a refusal into the open page instead of replacing it, and exchanges a setup
 * link. Adding a passkey needs the script.
 */
import type { Child } from "hono/jsx";
import { renderDocument } from "../pages/render.js";
import {
  Button,
  CommandBlock,
  Disclosure,
  FormFoot,
  MomentCard,
  Notice,
  PageShell,
  PasswordField,
  TextField,
} from "../pages/parts/index.js";
import { SETUP_STEP_COUNT, SETUP_WORDS } from "../pages/setup-words.js";

const steps = (current: number) => ({ current, total: SETUP_STEP_COUNT });

/** Where each owner step lives, so a step's links and its route agree. */
export const SETUP_STEP_PATHS = {
  passkey: "/setup/passkey",
  name: "/setup/name",
  connect: "/setup/connect",
  backups: "/setup/backups",
} as const;
export type OwnerStep = keyof typeof SETUP_STEP_PATHS;
export const OWNER_STEPS = Object.keys(SETUP_STEP_PATHS) as OwnerStep[];

/**
 * A refusal that belongs to the whole form rather than a field. It is always
 * in the markup: shown when the server has a message, and shown by the script
 * when a refusal reaches an open page.
 */
function FormNotice(props: { message?: string; slot?: string }) {
  return (
    <div
      data-notice={props.slot ?? "error"}
      hidden={props.message === undefined}
    >
      <Notice tone="error">
        <span data-notice-text>{props.message}</span>
      </Notice>
    </div>
  );
}

function Step(props: {
  title: string;
  lede: Child;
  current: number;
  children?: Child;
  needsScript?: boolean;
  nonce: string;
}) {
  return (
    <PageShell
      title={props.title}
      nonce={props.nonce}
      needsScript={props.needsScript}
    >
      <MomentCard
        title={props.title}
        lede={props.lede}
        steps={steps(props.current)}
      >
        {props.children}
      </MomentCard>
    </PageShell>
  );
}

export interface CodePageState {
  /** Why the code was refused, shown under the field. */
  codeError?: string;
  /** A refusal that is not about the code. */
  notice?: string;
}

/** Step 1: the setup code. */
export function renderCodePage(nonce: string, state: CodePageState = {}) {
  return renderDocument(
    <Step
      nonce={nonce}
      title="Claim this Marfa"
      lede="Enter the setup code to become its owner."
      current={1}
    >
      <form
        id="code-form"
        class="stack"
        method="post"
        action="/setup/exchange"
        novalidate
        data-setup-form="code"
      >
        <FormNotice message={state.notice} />
        <TextField
          id="code"
          name="code"
          label="Setup code"
          full
          code
          required
          autocomplete="off"
          placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-X"
          requiredMessage={SETUP_WORDS.noCode}
          error={state.codeError}
          autofocus={state.codeError !== undefined}
        />
        <Disclosure summary="Where's my setup code?">
          <div class="stack-8">
            <p class="small muted">
              Marfa prints it in its log when it starts without an owner. Or
              make a new one on the machine that runs Marfa:
            </p>
            <CommandBlock command="marfa setup code" />
            <p class="small muted">
              To skip typing it, run <code>marfa setup open</code> there
              instead. It opens a link that works once, for 5 minutes.
            </p>
          </div>
        </Disclosure>
        <Button kind="primary" type="submit" wide loadingLabel="Checking...">
          Continue
        </Button>
      </form>
    </Step>,
  );
}

export interface DetailsPageState {
  email?: string;
  name?: string;
  errors?: { email?: string; name?: string; password?: string };
  /** A refusal that is not about a field. */
  notice?: string;
}

/** Step 2: the owner's details. */
export function renderDetailsPage(nonce: string, state: DetailsPageState = {}) {
  const errors = state.errors ?? {};
  const firstInvalid = errors.email
    ? "email"
    : errors.name
      ? "name"
      : errors.password
        ? "password"
        : undefined;
  return renderDocument(
    <Step
      nonce={nonce}
      title="Your details"
      lede="You sign in with this email and password. Marfa sends no email."
      current={2}
    >
      <form
        id="owner-form"
        class="stack"
        method="post"
        action="/setup/claim"
        novalidate
        data-setup-form="details"
      >
        <FormNotice message={state.notice} />
        <div data-notice="ended" hidden>
          <Notice
            tone="error"
            action={
              <Button kind="quiet" href="/setup">
                Start again
              </Button>
            }
          >
            {SETUP_WORDS.sessionEnded}
          </Notice>
        </div>
        <TextField
          id="email"
          name="email"
          type="email"
          label="Email"
          full
          required
          autocomplete="username"
          value={state.email}
          requiredMessage={SETUP_WORDS.email}
          error={errors.email}
          autofocus={firstInvalid === "email"}
        />
        <TextField
          id="name"
          name="name"
          label="Name"
          full
          autocomplete="name"
          maxlength={200}
          value={state.name}
          hint="Optional. If you leave it blank, Marfa uses the part of your email before the @."
          error={errors.name}
          autofocus={firstInvalid === "name"}
        />
        <PasswordField
          id="password"
          name="password"
          label="Password"
          full
          required
          autocomplete="new-password"
          requiredMessage={SETUP_WORDS.password}
          hint="8 to 128 characters."
          error={errors.password}
          autofocus={firstInvalid === "password"}
        />
        <Button kind="primary" type="submit" wide loadingLabel="Claiming...">
          Claim Marfa
        </Button>
      </form>
    </Step>,
  );
}

/** A claimed instance: setup is closed, and the way on is to sign in. */
export function renderClaimedPage(nonce: string, instanceName: string) {
  return renderDocument(
    <PageShell title="This Marfa already has an owner" nonce={nonce}>
      <MomentCard
        title="This Marfa already has an owner"
        lede={`If it's yours, sign in to ${instanceName}.`}
      >
        <Button kind="primary" wide href="/auth/sign-in">
          Sign in
        </Button>
      </MomentCard>
    </PageShell>,
  );
}

function StepButtons(props: {
  back: string;
  next: string;
  nextLabel?: string;
}) {
  return (
    <div class="pair">
      <Button kind="outline" href={props.back}>
        Back
      </Button>
      <Button kind="primary" href={props.next}>
        {props.nextLabel ?? "Continue"}
      </Button>
    </div>
  );
}

/** Step 3: a passkey. The ceremony runs in the page; the server holds the rest. */
export function renderPasskeyPage(nonce: string) {
  return renderDocument(
    <Step
      nonce={nonce}
      title="Add a passkey"
      lede="Sign in with a fingerprint, your face or a security key instead of your password. You can add one later."
      current={3}
    >
      <div class="stack" data-passkey>
        <FormNotice slot="error" />
        <div data-notice="unsupported" hidden>
          <Notice tone="info">
            Passkeys need a supported browser and a secure HTTPS address (or
            localhost for development).
          </Notice>
        </div>
        <div data-notice="reauth" hidden>
          <Notice
            tone="info"
            title="Confirm it's you"
            action={
              <Button
                kind="quiet"
                href="/auth/sign-in?prompt=login&return_to=%2Fsetup%2Fpasskey"
              >
                Sign in again
              </Button>
            }
          >
            To add a passkey, sign in again first.
          </Notice>
        </div>
        <div class="stack" data-passkey-added hidden>
          <Notice tone="info" title="Passkey added">
            You can sign in with it from now on.
          </Notice>
          <Button kind="primary" wide href={SETUP_STEP_PATHS.name}>
            Continue
          </Button>
        </div>
        <div class="pair" data-passkey-ask>
          <Button kind="outline" href={SETUP_STEP_PATHS.name}>
            Skip
          </Button>
          <Button
            kind="primary"
            icon="passkey"
            hook="passkey-add"
            loadingLabel="Waiting for your passkey..."
            hidden
          >
            Add passkey
          </Button>
        </div>
      </div>
    </Step>,
  );
}

/** Step 4: the instance's name. */
export function renderNamePage(
  nonce: string,
  state: { name: string; error?: string },
) {
  return renderDocument(
    <Step
      nonce={nonce}
      title="Name this Marfa"
      lede="Shown on Marfa's own pages, such as sign-in and approvals."
      current={4}
    >
      <form
        class="stack"
        method="post"
        action={SETUP_STEP_PATHS.name}
        novalidate
      >
        <TextField
          id="instance-name"
          name="name"
          label="Name"
          full
          autocomplete="off"
          maxlength={200}
          value={state.name}
          hint="You can change it later."
          error={state.error}
          autofocus={state.error !== undefined}
        />
        <FormFoot>
          <Button kind="outline" href={SETUP_STEP_PATHS.passkey}>
            Back
          </Button>
          <Button kind="primary" type="submit" loadingLabel="Saving...">
            Continue
          </Button>
        </FormFoot>
      </form>
    </Step>,
  );
}

/** Step 5: how something connects. */
export function renderConnectPage(nonce: string) {
  return renderDocument(
    <Step
      nonce={nonce}
      title="Connect something"
      lede="Apps and tools use your data only after you approve them."
      current={5}
    >
      <div class="stack-24">
        <div class="stack-8">
          <p class="strong">The command line</p>
          <p class="small muted">
            Run this on your computer. Marfa asks you to approve it on a page
            like this one.
          </p>
          <CommandBlock command="marfa login" />
        </div>
        <div class="stack-8">
          <p class="strong">An app</p>
          <p class="small muted">
            When an app asks to connect, Marfa shows what it wants. You choose
            what it can access, and you can end its access at any time.
          </p>
        </div>
        <StepButtons
          back={SETUP_STEP_PATHS.name}
          next={SETUP_STEP_PATHS.backups}
        />
      </div>
    </Step>,
  );
}

/** Step 6: backups. Marfa does not report on them, and says so. */
export function renderBackupsPage(nonce: string) {
  return renderDocument(
    <Step
      nonce={nonce}
      title="Backing up"
      lede="Marfa keeps all its data in one folder on the machine that runs it. Back that folder up with your usual backup."
      current={6}
    >
      <div class="stack">
        <p class="small muted">
          Marfa doesn't report on backups, so check yours now and then. You can
          also export everything at any time with <code>marfa export</code>. An
          export moves your data to another Marfa, so it doesn't replace a
          backup.
        </p>
        <StepButtons
          back={SETUP_STEP_PATHS.connect}
          next="/auth/owner/manage"
          nextLabel="Done"
        />
      </div>
    </Step>,
  );
}

/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * Password and passkeys: how the owner signs in. The browser module
 * `client/account.ts` makes each change through the door that already makes
 * it: `POST /auth/change-password`, the passkey registration door and
 * `PATCH` and `DELETE /owner/passkeys/{id}`.
 */
import { renderDocument } from "../pages/render.js";
import { PASSWORD_MAX, PASSWORD_MIN } from "../auth/password-limits.js";
import {
  Button,
  ConsolePage,
  Dialog,
  EmptyState,
  Notice,
  PageHeader,
  PasswordField,
  Row,
  RowGroup,
  Section,
  TextField,
} from "../pages/parts/index.js";

export const PASSKEYS_HREF = "/auth/owner/passkeys";

export interface PasskeyView {
  id: string;
  /** The owner's name for it, or `null` when it has none. */
  name: string | null;
  /** When it was added, already written for a person. */
  added: string;
}

export interface PasswordPageParams {
  nonce: string;
  instanceName: string;
  passkeys: readonly PasskeyView[];
  /** What the Add dialog starts with: this browser and system, not already used. */
  suggestedName: string;
  /** Passkeys cannot work at the address Marfa is open at. */
  addressProblem: boolean;
}

const UNNAMED = "Passkey";

function Cancel() {
  return (
    <Button kind="outline" closes>
      Cancel
    </Button>
  );
}

function PasswordDialog() {
  return (
    <Dialog
      id="password-dialog"
      title="Change password"
      description="Your other browsers will be signed out. Connected apps and keys keep their access."
      actions={
        <>
          <Cancel />
          <Button
            kind="primary"
            type="submit"
            form="password-form"
            loadingLabel="Changing..."
          >
            Change password
          </Button>
        </>
      }
    >
      <form
        id="password-form"
        method="dialog"
        novalidate
        class="stack"
        data-account-form="password"
      >
        <PasswordField
          id="password-current"
          name="currentPassword"
          label="Current password"
          autocomplete="current-password"
          full
        />
        <PasswordField
          id="password-new"
          name="newPassword"
          label="New password"
          hint={`${String(PASSWORD_MIN)} to ${String(PASSWORD_MAX)} characters.`}
          autocomplete="new-password"
          full
        />
      </form>
    </Dialog>
  );
}

function AddDialog(props: { suggestedName: string }) {
  return (
    <Dialog
      id="passkey-add"
      title="Add a passkey"
      description="Your browser asks for your fingerprint, your face or a security key. Give the passkey a name so you can tell it apart."
      actions={
        <>
          <Cancel />
          <Button
            kind="primary"
            type="submit"
            form="passkey-add-form"
            loadingLabel="Adding..."
          >
            Add passkey
          </Button>
        </>
      }
    >
      <form
        id="passkey-add-form"
        method="dialog"
        novalidate
        data-account-form="passkey-add"
        data-refresh=""
        data-after="add-passkey"
      >
        <TextField
          id="passkey-add-name"
          name="name"
          label="Name"
          value={props.suggestedName}
          autocomplete="off"
          full
        />
      </form>
    </Dialog>
  );
}

function ManageDialogs(props: { passkey: PasskeyView; index: number }) {
  const { passkey, index } = props;
  const manage = `passkey-manage-${String(index)}`;
  const remove = `passkey-remove-${String(index)}`;
  const name = passkey.name ?? UNNAMED;
  return (
    <>
      <Dialog
        id={manage}
        title="Manage passkey"
        actions={
          <>
            <Cancel />
            <Button
              kind="primary"
              type="submit"
              form={`${manage}-form`}
              loadingLabel="Saving..."
            >
              Save name
            </Button>
          </>
        }
      >
        <form
          id={`${manage}-form`}
          method="dialog"
          novalidate
          class="stack"
          data-account-form="passkey-rename"
          data-passkey-id={passkey.id}
          data-refresh=""
          data-after={`manage-${passkey.id}`}
        >
          <TextField
            id={`${manage}-name`}
            name="name"
            label="Name"
            value={passkey.name ?? ""}
            autocomplete="off"
            full
          />
          <RowGroup>
            <Row
              title="Remove passkey"
              description="You can still sign in with your password"
              buttons={
                <Button kind="danger-quiet" opens={remove}>
                  Remove passkey
                </Button>
              }
            />
          </RowGroup>
        </form>
      </Dialog>
      <Dialog
        id={remove}
        title={`Remove ${name}?`}
        description="You can still sign in with your password."
        actions={
          <>
            <Cancel />
            <Button
              kind="danger"
              type="submit"
              form={`${remove}-form`}
              loadingLabel="Removing..."
            >
              Remove passkey
            </Button>
          </>
        }
      >
        <form
          id={`${remove}-form`}
          method="dialog"
          data-account-form="passkey-remove"
          data-passkey-id={passkey.id}
          data-refresh=""
          data-after="add-passkey"
        >
          <div data-notice="error" hidden>
            <Notice tone="error">
              <span data-notice-text></span>
            </Notice>
          </div>
        </form>
      </Dialog>
    </>
  );
}

export function PasswordPage(props: PasswordPageParams) {
  return (
    <ConsolePage
      title="Password and passkeys"
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[{ label: "Password and passkeys" }]}
      pageId="password"
    >
      <div class="stack-24">
        <PageHeader
          title="Password and passkeys"
          lede="How you sign in. Marfa sends no email, so a forgotten password is reset on the machine Marfa runs on."
        />
        <div data-notice="done" hidden>
          <Notice>
            <span data-notice-text></span>
          </Notice>
        </div>
      </div>
      <RowGroup>
        <Row
          id="password"
          title="Password"
          description="Changing it signs out your other browsers"
          buttons={
            <Button kind="quiet" opens="password-dialog" hook="change-password">
              Change password
            </Button>
          }
        />
      </RowGroup>
      <PasswordDialog />
      <Section
        id="passkeys"
        title="Passkeys"
        description="Sign in with a fingerprint, your face or a security key instead of your password."
        control={
          <Button
            kind="quiet"
            hook="add-passkey"
            data={{ "account-add": "passkey-add" }}
            hidden
          >
            Add passkey
          </Button>
        }
      >
        <div data-notice="unsupported" hidden={!props.addressProblem}>
          <Notice tone="error">
            Passkeys can't be added here. Use a current browser at the address
            Marfa is set up on, which has to be a web address that starts with
            https:// or is localhost, and not an IP address.
          </Notice>
        </div>
        <div data-live>
          {props.passkeys.length === 0 ? (
            <RowGroup>
              <EmptyState
                title="No passkeys yet"
                description="Add one to sign in without typing your password."
              />
            </RowGroup>
          ) : (
            <RowGroup>
              {props.passkeys.map((passkey, index) => (
                <Row
                  title={passkey.name ?? UNNAMED}
                  description={`Added ${passkey.added}`}
                  buttons={
                    <Button
                      kind="quiet"
                      opens={`passkey-manage-${String(index)}`}
                      hook={`manage-${passkey.id}`}
                    >
                      Manage
                    </Button>
                  }
                />
              ))}
            </RowGroup>
          )}
          <AddDialog suggestedName={props.suggestedName} />
          {props.passkeys.map((passkey, index) => (
            <ManageDialogs passkey={passkey} index={index} />
          ))}
        </div>
        <p class="secd">
          Passkeys need a secure HTTPS address, or localhost for development.
          Use this same address each time you sign in.
        </p>
      </Section>
    </ConsolePage>
  );
}

export function renderPasswordPage(params: PasswordPageParams): string {
  return renderDocument(<PasswordPage {...params} />);
}

import { describe, expect, it } from "vitest";
import {
  ForbiddenError,
  MarfaError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "../errors.js";
import { classifyFailure } from "./classify.js";

describe("the failure classification", () => {
  it("treats an unreachable server as no attempt at all", () => {
    expect(
      classifyFailure(
        new MarfaError("network_error", "Network request failed", 0),
        "item.create",
      ),
    ).toMatchObject({ class: "offline" });
    expect(
      classifyFailure(
        new MarfaError("timeout", "Request timed out", 0),
        "item.create",
      ),
    ).toMatchObject({ class: "offline" });
  });

  it("parks the queue on a spent credential", () => {
    expect(
      classifyFailure(new UnauthorizedError("expired"), "item.create"),
    ).toMatchObject({ class: "auth" });
  });

  it("dead-letters a refusal a retry cannot change", () => {
    // A 400 that is not about properties against a type. A registry
    // refresh cannot help here: this one says the *server* has no such
    // type, and reading the server's vocabulary again returns the same
    // answer.
    expect(
      classifyFailure(
        new ValidationError("no such type", undefined, "unknown_type"),
        "item.create",
      ),
    ).toMatchObject({ class: "permanent", httpStatus: 400 });
    expect(
      classifyFailure(new NotFoundError("gone"), "item.delete"),
    ).toMatchObject({ class: "permanent", httpStatus: 404 });
    expect(
      classifyFailure(
        new ForbiddenError("not yours", undefined, "forbidden"),
        "item.update",
      ),
    ).toMatchObject({ class: "permanent", httpStatus: 403 });
  });

  it("reads a schema refusal under either code the server answers it with", () => {
    // One refusal, two codes, and which one arrives depends on the door.
    // Creating an item raises the storage layer's generic validation code;
    // updating, upserting, bulk-writing and the strict-mode pre-check raise
    // the route layer's specific one. A classification taught only one of
    // them dead-letters a schema refusal from the other door without the
    // registry refresh the contract owes it — silently, because a dead
    // letter is what a permanent refusal is supposed to produce.
    //
    // The codes are crossed with the kinds deliberately, and the kind is
    // deliberately irrelevant: this arm answers on the code alone, so all
    // four rows must agree. That is worth pinning rather than assuming,
    // because the arm immediately below it does read the kind — a 409 is
    // a conflict on an update and permanent on a create — so "the kind
    // decides" is true one branch away, and a well-meant symmetry here
    // would send a schema refusal from the create door to a dead letter.
    for (const [code, kind] of [
      ["validation_error", "item.create"],
      ["invalid_properties", "item.update"],
      ["invalid_properties", "item.create"],
      ["validation_error", "item.update"],
    ] as const) {
      expect(
        classifyFailure(new MarfaError(code, "Invalid properties", 400), kind),
      ).toMatchObject({ class: "schema", code, httpStatus: 400 });
    }
  });

  it("reads a 409 by what was being written", () => {
    // The same status, two situations. On a create the id belongs to a row
    // this client did not write, so there is no version to rebase onto and
    // nothing a person could review — the write is refused for good. On an
    // update the row has moved under an edit that is still wanted, which
    // is neither a refusal nor something to repeat.
    expect(
      classifyFailure(
        new MarfaError("conflict", "id is taken", 409),
        "item.create",
      ),
    ).toMatchObject({ class: "permanent", httpStatus: 409 });
    expect(
      classifyFailure(
        new MarfaError("version_conflict", "row moved on", 409),
        "item.update",
      ),
    ).toMatchObject({ class: "conflict", code: "version_conflict" });
    expect(
      classifyFailure(
        new MarfaError("version_conflict", "edge moved on", 409),
        "edge.update",
      ),
    ).toMatchObject({ class: "conflict", code: "version_conflict" });
  });

  it("keeps a base the server can no longer merge against separate", () => {
    // The snapshot the edit was computed against has been thinned away, so
    // there is nothing for either side to merge over. It reaches the app as
    // a conflict like any other, carrying the code that says the two
    // versions have to be shown rather than reconciled.
    expect(
      classifyFailure(
        new MarfaError("ancestor_unavailable", "snapshot thinned", 409),
        "item.update",
      ),
    ).toMatchObject({ class: "conflict", code: "ancestor_unavailable" });
  });

  it("waits out a key another request is still serving", () => {
    // Nothing has been decided about this write: the server is telling the
    // caller to ask again. Read as a conflict it would park a mutation
    // that needed a moment, and on a create it would dead-letter one the
    // server may be in the middle of accepting.
    expect(
      classifyFailure(
        new MarfaError("idempotency_key_in_flight", "still serving", 409),
        "item.create",
      ),
    ).toMatchObject({ class: "transient" });
    expect(
      classifyFailure(
        new MarfaError("idempotency_key_in_flight", "still serving", 409),
        "item.update",
      ),
    ).toMatchObject({ class: "transient" });
  });

  it("dead-letters a body the server will never take", () => {
    // A queued payload cannot be edited — no door takes "the same write,
    // smaller" — so a retry budget spent on it ends with `retry_ceiling`,
    // whose own promise is that retrying later is the right move. It is
    // not. The dead letter keeps the write for a person to resend in a
    // shape that fits.
    expect(
      classifyFailure(
        new MarfaError("request_too_large", "body too large", 413),
        "item.create",
      ),
    ).toMatchObject({ class: "permanent" });
  });

  it("parks a key that was spent on a different body", () => {
    // Distinct from the in-flight case above, and the two are easy to
    // read as one because both are about the key. That one says nothing
    // has been decided and to ask again; this one says the key has
    // already been answered for a different request.
    //
    // The engine can produce it: the drain reads the version from its
    // local mirror at drain time, so a transient failure followed by an
    // inbound event sends a new version under the key the mutation was
    // written with.
    //
    // Not transient — a retry sends the same different body and meets the
    // same refusal, and the person is then told the write ran out of
    // retries when it was refused on the first. Not permanent — the edit
    // is still wanted; it is the key that is spent.
    expect(
      classifyFailure(
        new MarfaError("idempotency_key_reused", "already answered", 422),
        "item.update",
      ),
    ).toMatchObject({ class: "blocked", reason: "needs_review" });

    // By code, not by status: the same status carries refusals this
    // engine's writes cannot produce, and reading the status alone would
    // classify them without anyone having checked.
    expect(
      classifyFailure(
        new MarfaError("compatible_with_violation", "unrelated", 422),
        "item.update",
      ),
    ).toMatchObject({ class: "transient" });
  });

  it("parks a write whose outcome the server can no longer report", () => {
    // The key was kept, so the write will not be performed twice, and the
    // stored answer is gone, so nothing can say whether the first attempt
    // landed. Retrying gets this same answer for ever and dead-lettering
    // claims a refusal that may never have happened, so it goes to the
    // person along with the rest of what cannot be settled here.
    expect(
      classifyFailure(
        new MarfaError("idempotency_result_not_retained", "body gone", 422),
        "item.create",
      ),
    ).toMatchObject({ class: "blocked", reason: "needs_review" });
  });

  it("parks a refusal whose stated cause will pass", () => {
    // The status says nothing about permanence on its own — a 403 is
    // usually final and a 429 is usually a wait. The code is what
    // separates a space that will come back from an authority that will
    // not, and a quota from a rate limit.
    expect(
      classifyFailure(
        new ForbiddenError("space suspended", undefined, "space_suspended"),
        "item.create",
      ),
    ).toMatchObject({ class: "blocked", reason: "space_suspended" });
    expect(
      classifyFailure(
        new MarfaError("quota_exceeded", "no room", 429),
        "item.create",
      ),
    ).toMatchObject({ class: "blocked", reason: "quota_exceeded" });
  });

  it("retries a rate limit and a server error", () => {
    expect(
      classifyFailure(
        new MarfaError("rate_limited", "slow down", 429),
        "item.create",
      ),
    ).toMatchObject({ class: "transient" });
    expect(
      classifyFailure(
        new MarfaError("internal_error", "boom", 500),
        "item.create",
      ),
    ).toMatchObject({ class: "transient" });
    expect(
      classifyFailure(
        new MarfaError("unavailable", "restarting", 503),
        "item.create",
      ),
    ).toMatchObject({ class: "transient" });
  });

  it("keeps a mutation whose failure it does not recognize", () => {
    // A throw the engine did not expect is a defect rather than a verdict
    // on the write, so the write is kept and tried again. The ceiling is
    // what stops that becoming forever.
    expect(
      classifyFailure(new Error("something else"), "item.create"),
    ).toMatchObject({ class: "transient", message: "something else" });
  });
});

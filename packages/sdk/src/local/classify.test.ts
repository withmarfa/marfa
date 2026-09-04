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
      ),
    ).toMatchObject({ class: "offline" });
    expect(
      classifyFailure(new MarfaError("timeout", "Request timed out", 0)),
    ).toMatchObject({ class: "offline" });
  });

  it("parks the queue on a spent credential", () => {
    expect(classifyFailure(new UnauthorizedError("expired"))).toMatchObject({
      class: "auth",
    });
  });

  it("dead-letters a refusal a retry cannot change", () => {
    expect(classifyFailure(new ValidationError("bad"))).toMatchObject({
      class: "permanent",
      httpStatus: 400,
    });
    expect(classifyFailure(new NotFoundError("gone"))).toMatchObject({
      class: "permanent",
      httpStatus: 404,
    });
    expect(
      classifyFailure(new ForbiddenError("not yours", undefined, "forbidden")),
    ).toMatchObject({ class: "permanent", httpStatus: 403 });
    expect(
      classifyFailure(new MarfaError("conflict", "id is taken", 409)),
    ).toMatchObject({ class: "permanent", httpStatus: 409 });
  });

  it("parks a refusal whose stated cause will pass", () => {
    // The status says nothing about permanence on its own — a 403 is
    // usually final and a 429 is usually a wait. The code is what
    // separates a space that will come back from an authority that will
    // not, and a quota from a rate limit.
    expect(
      classifyFailure(
        new ForbiddenError("space suspended", undefined, "space_suspended"),
      ),
    ).toMatchObject({ class: "blocked", reason: "space_suspended" });
    expect(
      classifyFailure(new MarfaError("quota_exceeded", "no room", 429)),
    ).toMatchObject({ class: "blocked", reason: "quota_exceeded" });
  });

  it("retries a rate limit and a server error", () => {
    expect(
      classifyFailure(new MarfaError("rate_limited", "slow down", 429)),
    ).toMatchObject({ class: "transient" });
    expect(
      classifyFailure(new MarfaError("internal_error", "boom", 500)),
    ).toMatchObject({ class: "transient" });
    expect(
      classifyFailure(new MarfaError("unavailable", "restarting", 503)),
    ).toMatchObject({ class: "transient" });
  });

  it("keeps a mutation whose failure it does not recognize", () => {
    // A throw the engine did not expect is a defect rather than a verdict
    // on the write, so the write is kept and tried again. The ceiling is
    // what stops that becoming forever.
    expect(classifyFailure(new Error("something else"))).toMatchObject({
      class: "transient",
      message: "something else",
    });
  });
});

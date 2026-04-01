import { describe, expect, it } from "vitest";
import { ErrorCode, ProtocolError, httpStatus } from "./errors.js";

describe("ErrorCode", () => {
  it("has all expected error codes", () => {
    expect(ErrorCode.NOT_FOUND).toBe("not_found");
    expect(ErrorCode.ITEM_NOT_FOUND).toBe("item_not_found");
    expect(ErrorCode.THREAD_NOT_FOUND).toBe("thread_not_found");
    expect(ErrorCode.BLOB_NOT_FOUND).toBe("blob_not_found");
    expect(ErrorCode.VALIDATION_ERROR).toBe("validation_error");
    expect(ErrorCode.VERSION_CONFLICT).toBe("version_conflict");
    expect(ErrorCode.UNAUTHORIZED).toBe("unauthorized");
    expect(ErrorCode.FORBIDDEN).toBe("forbidden");
    expect(ErrorCode.INVALID_TRANSITION).toBe("invalid_transition");
    expect(ErrorCode.TYPE_NOT_FOUND).toBe("type_not_found");
    expect(ErrorCode.DUPLICATE_SOURCE).toBe("duplicate_source");
  });
});

describe("httpStatus", () => {
  it("maps error codes to HTTP status codes", () => {
    expect(httpStatus(ErrorCode.NOT_FOUND)).toBe(404);
    expect(httpStatus(ErrorCode.ITEM_NOT_FOUND)).toBe(404);
    expect(httpStatus(ErrorCode.THREAD_NOT_FOUND)).toBe(404);
    expect(httpStatus(ErrorCode.BLOB_NOT_FOUND)).toBe(404);
    expect(httpStatus(ErrorCode.VALIDATION_ERROR)).toBe(400);
    expect(httpStatus(ErrorCode.VERSION_CONFLICT)).toBe(409);
    expect(httpStatus(ErrorCode.UNAUTHORIZED)).toBe(401);
    expect(httpStatus(ErrorCode.FORBIDDEN)).toBe(403);
    expect(httpStatus(ErrorCode.INVALID_TRANSITION)).toBe(400);
    expect(httpStatus(ErrorCode.TYPE_NOT_FOUND)).toBe(404);
    expect(httpStatus(ErrorCode.DUPLICATE_SOURCE)).toBe(409);
  });
});

describe("ProtocolError", () => {
  it("constructs with code, message, and status", () => {
    const err = new ProtocolError(ErrorCode.NOT_FOUND, "Item not found");
    expect(err.code).toBe(ErrorCode.NOT_FOUND);
    expect(err.message).toBe("Item not found");
    expect(err.status).toBe(404);
    expect(err.name).toBe("ProtocolError");
    expect(err.details).toBeUndefined();
  });

  it("accepts optional details", () => {
    const err = new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid field", {
      field: "title",
      reason: "required",
    });
    expect(err.details).toEqual({ field: "title", reason: "required" });
  });

  it("extends Error", () => {
    const err = new ProtocolError(ErrorCode.FORBIDDEN, "Access denied");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ProtocolError);
  });

  it("serializes to error response format", () => {
    const err = new ProtocolError(ErrorCode.NOT_FOUND, "Item not found");
    expect(err.toResponse()).toEqual({
      error: {
        code: "not_found",
        message: "Item not found",
      },
    });
  });

  it("includes details in error response when present", () => {
    const err = new ProtocolError(
      ErrorCode.VERSION_CONFLICT,
      "Conflict detected",
      { version: 3 },
    );
    expect(err.toResponse()).toEqual({
      error: {
        code: "version_conflict",
        message: "Conflict detected",
        details: { version: 3 },
      },
    });
  });

  it("omits details from error response when absent", () => {
    const err = new ProtocolError(ErrorCode.UNAUTHORIZED, "No API key");
    const response = err.toResponse();
    expect(response.error).not.toHaveProperty("details");
  });
});

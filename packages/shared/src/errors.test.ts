import { describe, expect, it } from "vitest";
import { ErrorCode, MarfaError, httpStatus } from "./errors.js";

describe("ErrorCode", () => {
  it("has all expected error codes", () => {
    expect(ErrorCode.NOT_FOUND).toBe("not_found");
    expect(ErrorCode.ITEM_NOT_FOUND).toBe("item_not_found");
    expect(ErrorCode.BLOB_NOT_FOUND).toBe("blob_not_found");
    expect(ErrorCode.VALIDATION_ERROR).toBe("validation_error");
    expect(ErrorCode.VERSION_CONFLICT).toBe("version_conflict");
    expect(ErrorCode.UNAUTHORIZED).toBe("unauthorized");
    expect(ErrorCode.FORBIDDEN).toBe("forbidden");
    expect(ErrorCode.INVALID_TRANSITION).toBe("invalid_transition");
    expect(ErrorCode.TYPE_NOT_FOUND).toBe("type_not_found");
  });

  it("includes resource-specific codes", () => {
    expect(ErrorCode.OWNER_EXISTS).toBe("owner_exists");
    expect(ErrorCode.OWNER_NOT_FOUND).toBe("owner_not_found");
    expect(ErrorCode.API_KEY_NOT_FOUND).toBe("api_key_not_found");
    expect(ErrorCode.OAUTH_GRANT_NOT_FOUND).toBe("oauth_grant_not_found");
  });
});

describe("httpStatus", () => {
  it("maps error codes to HTTP status codes", () => {
    expect(httpStatus(ErrorCode.NOT_FOUND)).toBe(404);
    expect(httpStatus(ErrorCode.ITEM_NOT_FOUND)).toBe(404);
    expect(httpStatus(ErrorCode.BLOB_NOT_FOUND)).toBe(404);
    expect(httpStatus(ErrorCode.VALIDATION_ERROR)).toBe(400);
    expect(httpStatus(ErrorCode.VERSION_CONFLICT)).toBe(409);
    expect(httpStatus(ErrorCode.UNAUTHORIZED)).toBe(401);
    expect(httpStatus(ErrorCode.FORBIDDEN)).toBe(403);
    expect(httpStatus(ErrorCode.INVALID_TRANSITION)).toBe(400);
    expect(httpStatus(ErrorCode.TYPE_NOT_FOUND)).toBe(404);
    expect(httpStatus(ErrorCode.UNKNOWN_TYPE)).toBe(400);
  });

  it("maps resource-specific codes to expected statuses", () => {
    expect(httpStatus(ErrorCode.OWNER_EXISTS)).toBe(409);
    expect(httpStatus(ErrorCode.OWNER_NOT_FOUND)).toBe(404);
    expect(httpStatus(ErrorCode.API_KEY_NOT_FOUND)).toBe(404);
    expect(httpStatus(ErrorCode.OAUTH_GRANT_NOT_FOUND)).toBe(404);
  });
});

describe("MarfaError", () => {
  it("constructs with code, message, and status", () => {
    const err = new MarfaError(ErrorCode.NOT_FOUND, "Item not found");
    expect(err.code).toBe(ErrorCode.NOT_FOUND);
    expect(err.message).toBe("Item not found");
    expect(err.status).toBe(404);
    expect(err.name).toBe("MarfaError");
    expect(err.details).toBeUndefined();
  });

  it("accepts optional details", () => {
    const err = new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid field", {
      field: "title",
      reason: "required",
    });
    expect(err.details).toEqual({ field: "title", reason: "required" });
  });

  it("extends Error", () => {
    const err = new MarfaError(ErrorCode.FORBIDDEN, "Access denied");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MarfaError);
  });

  it("serializes to error response format", () => {
    const err = new MarfaError(ErrorCode.NOT_FOUND, "Item not found");
    expect(err.toResponse()).toEqual({
      error: {
        code: "not_found",
        message: "Item not found",
      },
    });
  });

  it("includes details in error response when present", () => {
    const err = new MarfaError(
      ErrorCode.VERSION_CONFLICT,
      "Conflict detected",
      {
        version: 3,
      },
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
    const err = new MarfaError(ErrorCode.UNAUTHORIZED, "No API key");
    const response = err.toResponse();
    expect(response.error).not.toHaveProperty("details");
  });
});

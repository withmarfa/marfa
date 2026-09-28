import { describe, expect, it } from "vitest";
import { bodyCapFor } from "./body-cap.js";

describe("bodyCapFor", () => {
  it("names each door's cap, in either spelling of a path", () => {
    const caps = Object.fromEntries(
      [
        "/items",
        "/items/{id}",
        "/edges",
        "/webhooks",
        "/items/bulk",
        "/items/bulk-get",
        "/items/bulk-actions",
        "/edges/bulk",
        "/blobs",
        "/blobs/{hash}",
        "/blobs/:hash",
        "/admin/restore-archive",
        "/inbound/{token}",
        "/inbound/:token",
      ].map((path) => [path, bodyCapFor(path)]),
    );
    expect(caps).toEqual({
      "/items": "request",
      "/items/{id}": "request",
      "/edges": "request",
      "/webhooks": "request",
      "/items/bulk": "bulk",
      "/items/bulk-get": "bulk",
      "/items/bulk-actions": "bulk",
      "/edges/bulk": "bulk",
      "/blobs": "none",
      "/blobs/{hash}": "none",
      "/blobs/:hash": "none",
      "/admin/restore-archive": "none",
      "/inbound/{token}": "inbound",
      "/inbound/:token": "inbound",
    });
  });
});

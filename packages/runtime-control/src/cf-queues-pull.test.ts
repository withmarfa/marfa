import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  pullMessages,
  ackMessages,
  resolveQueueId,
  CfQueuesNotConfiguredError,
  _resetQueueIdCacheForTests,
} from "./cf-queues-pull.js";

const VALID_ENV = {
  CLOUDFLARE_QUEUES_API_TOKEN: "tok_test",
  CLOUDFLARE_ACCOUNT_ID: "acc_test",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("cf-queues-pull", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    _resetQueueIdCacheForTests();
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("pullMessages", () => {
    it("posts to the pull endpoint with batch + visibility opts and decodes JSON bodies", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          errors: [],
          result: {
            message_backlog_count: 1,
            messages: [
              {
                id: "msg_1",
                lease_id: "lease_a",
                body: JSON.stringify({ connection_id: "conn_x", v: 1 }),
                timestamp_ms: 1700000000000,
                attempts: 3,
                metadata: { "CF-Content-Type": "json" },
              },
            ],
          },
        }),
      );

      const messages = await pullMessages(VALID_ENV, "queue_uuid", {
        batchSize: 50,
        visibilityTimeoutMs: 5000,
      });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const call = fetchSpy.mock.calls[0] as [string, RequestInit];
      const url = call[0];
      const init = call[1];
      expect(url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/acc_test/queues/queue_uuid/messages/pull",
      );
      expect(init.method).toBe("POST");
      expect(
        JSON.parse(typeof init.body === "string" ? init.body : ""),
      ).toEqual({
        batch_size: 50,
        visibility_timeout_ms: 5000,
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        cf_message_id: "msg_1",
        lease_id: "lease_a",
        body: { connection_id: "conn_x", v: 1 },
        timestamp_ms: 1700000000000,
        attempts: 3,
      });
    });

    it("returns an empty array when the queue has no messages", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          errors: [],
          result: { message_backlog_count: 0, messages: [] },
        }),
      );

      const messages = await pullMessages(VALID_ENV, "queue_uuid");
      expect(messages).toEqual([]);
    });

    it("falls back to raw string when the body fails to JSON-parse", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          errors: [],
          result: {
            message_backlog_count: 1,
            messages: [
              {
                id: "msg_2",
                lease_id: "lease_b",
                body: "not valid json {",
                timestamp_ms: 1700000000000,
                attempts: 1,
                metadata: { "CF-Content-Type": "json" },
              },
            ],
          },
        }),
      );

      const messages = await pullMessages(VALID_ENV, "queue_uuid");
      expect(messages[0]?.body).toBe("not valid json {");
    });

    it("throws CfQueuesNotConfiguredError when the token is missing", async () => {
      await expect(
        pullMessages({ CLOUDFLARE_ACCOUNT_ID: "acc" }, "queue_uuid"),
      ).rejects.toBeInstanceOf(CfQueuesNotConfiguredError);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("surfaces upstream API errors with the error envelope", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            errors: [{ code: 7000, message: "queue not found" }],
            result: null,
          },
          404,
        ),
      );

      await expect(pullMessages(VALID_ENV, "queue_uuid")).rejects.toThrow(
        /queue not found/,
      );
    });
  });

  describe("ackMessages", () => {
    it("posts the lease_ids array and returns ackCount", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          errors: [],
          result: { ackCount: 2, retryCount: 0, warnings: {} },
        }),
      );

      const result = await ackMessages(VALID_ENV, "queue_uuid", [
        "lease_a",
        "lease_b",
      ]);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const call = fetchSpy.mock.calls[0] as [string, RequestInit];
      const url = call[0];
      const init = call[1];
      expect(url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/acc_test/queues/queue_uuid/messages/ack",
      );
      expect(
        JSON.parse(typeof init.body === "string" ? init.body : ""),
      ).toEqual({
        acks: [{ lease_id: "lease_a" }, { lease_id: "lease_b" }],
      });
      expect(result.ackCount).toBe(2);
    });

    it("short-circuits to no-op when leaseIds is empty", async () => {
      const result = await ackMessages(VALID_ENV, "queue_uuid", []);
      expect(result).toEqual({ ackCount: 0, warnings: {} });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("resolveQueueId", () => {
    it("lists queues, populates the cache, and returns the matching id", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          errors: [],
          result: [
            { queue_id: "id_a", queue_name: "q-a" },
            { queue_id: "id_b", queue_name: "q-b" },
          ],
        }),
      );

      const id = await resolveQueueId(VALID_ENV, "q-b");
      expect(id).toBe("id_b");
      expect(fetchSpy).toHaveBeenCalledOnce();

      // Subsequent lookups (for either queue listed in the same response)
      // hit the cache rather than re-listing.
      const cached = await resolveQueueId(VALID_ENV, "q-a");
      expect(cached).toBe("id_a");
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it("returns null when the queue does not exist on the account", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          errors: [],
          result: [{ queue_id: "id_a", queue_name: "q-a" }],
        }),
      );

      const id = await resolveQueueId(VALID_ENV, "q-missing");
      expect(id).toBeNull();
    });

    it("re-lists when the cache is empty for a fresh queue name", async () => {
      // First call: lists once.
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          errors: [],
          result: [{ queue_id: "id_a", queue_name: "q-a" }],
        }),
      );
      const first = await resolveQueueId(VALID_ENV, "q-a");
      expect(first).toBe("id_a");

      // Second resolve for a different queue not yet cached → re-lists.
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          errors: [],
          result: [
            { queue_id: "id_a", queue_name: "q-a" },
            { queue_id: "id_c", queue_name: "q-c" },
          ],
        }),
      );
      const second = await resolveQueueId(VALID_ENV, "q-c");
      expect(second).toBe("id_c");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });
});

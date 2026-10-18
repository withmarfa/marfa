/** Names and descriptions shared by registration and generated reference tables. */
export const HOUSEKEEPING_JOBS = {
  "event-log-cleanup": {
    name: "event-log-cleanup",
    description: "Removes expired event log entries and idempotency records.",
  },
  "audit-cleanup": {
    name: "audit-cleanup",
    description:
      "Removes expired audit entries and outbound webhook delivery history.",
  },
  "webhook-schedule": {
    name: "webhook-schedule",
    description: "Schedules outbound webhook deliveries for new events.",
  },
  "webhook-poll": {
    name: "webhook-poll",
    description:
      "Sends pending outbound webhook deliveries and retries failures.",
  },
  heartbeat: {
    name: "heartbeat",
    description: "Pings the configured liveness receiver.",
  },
  "version-thinning": {
    name: "version-thinning",
    description:
      "Thins item versions according to the configured retention policy.",
  },
  "feed-expiry": {
    name: "feed-expiry",
    description: "Moves expired feed items to the trash.",
  },
  "trash-purge": {
    name: "trash-purge",
    description: "Permanently removes items whose trash retention has elapsed.",
  },
  "revoked-grant-purge": {
    name: "revoked-grant-purge",
    description:
      "Removes revoked application grants after their retention window.",
  },
  "grant-inactivity-retirement": {
    name: "grant-inactivity-retirement",
    description:
      "Revokes application grants that have not been used within the inactivity window.",
  },
  "revoked-key-reap": {
    name: "revoked-key-reap",
    description: "Removes revoked or expired keys after the retention window.",
  },
  "auth-session-cleanup": {
    name: "auth-session-cleanup",
    description: "Removes expired authentication sessions.",
  },
  "rate-limit-cleanup": {
    name: "rate-limit-cleanup",
    description: "Removes expired rate limit windows.",
  },
  "inbound-delivery-cleanup": {
    name: "inbound-delivery-cleanup",
    description:
      "Removes inbound deliveries after their handled or pending retention window.",
  },
  "dcr-client-cleanup": {
    name: "dcr-client-cleanup",
    description:
      "Removes OAuth clients with no remaining grant after their retention window.",
  },
  "blob-replicate": {
    name: "blob-replicate",
    description:
      "Copies blobs to satisfy each attached store's replication policy.",
  },
  "blob-integrity": {
    name: "blob-integrity",
    description:
      "Checks blob copies and removes locations whose bytes are missing or altered.",
  },
  "blob-orphans": {
    name: "blob-orphans",
    description:
      "Reports unreferenced blobs and purges them after the grace period.",
  },
  "enrichment-sweep": {
    name: "enrichment-sweep",
    description:
      "Extracts searchable text and image dimensions from uploaded files.",
  },
  "bulk-action-gc": {
    name: "bulk-action-gc",
    description:
      "Removes completed bulk action jobs after their retention window.",
  },
} as const;

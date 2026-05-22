-- T-224: naming-consistency pass.
--
-- (1) Rename the `workspace_admin` role to `tenant_admin`. The enum value
--     is renamed in @mymehq/shared (MymeRole); this realigns existing
--     rows. The `role` column lives on both `users` (T-178 — projected
--     onto OAuth bearer principals) and `api_keys`.
-- (2) Rename the `outbound_webhook_deliveries.success` boolean column to
--     `succeeded` — a bare noun normalised to a participle per the
--     boolean-naming convention.

UPDATE "users" SET "role" = 'tenant_admin' WHERE "role" = 'workspace_admin';
--> statement-breakpoint
UPDATE "api_keys" SET "role" = 'tenant_admin' WHERE "role" = 'workspace_admin';
--> statement-breakpoint
ALTER TABLE "outbound_webhook_deliveries" RENAME COLUMN "success" TO "succeeded";

-- T-049: blob storage tenant scoping. See sqlite/0032 for design.
--
-- PG can swap the PK in place: drop the existing single-column PK,
-- add the tenant_id column with a default that backfills existing rows,
-- then add the composite PK.

ALTER TABLE "blobs" DROP CONSTRAINT IF EXISTS "blobs_pkey";
--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "tenant_id" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_tenant_id_hash_pk" PRIMARY KEY ("tenant_id", "hash");

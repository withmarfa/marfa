-- Custom edge types become tenant-namespaced. See sqlite/0053 for design.
--
-- The `custom_edge_types` table moves from a global PK on `id` to a
-- composite PK on (tenant_id, id) so two tenants can register the same
-- edge-type id independently. The `tenant_id` column already exists but is
-- nullable; this migration backfills existing NULL rows to the empty-string
-- sentinel '' (single-tenant self-host / platform), makes the column
-- NOT NULL DEFAULT '', and swaps the PK in place. The RLS policy is updated
-- from the `tenant_id IS NULL` allowance to the `tenant_id = ''` sentinel
-- so the policy matches the new column semantics (mirrors `blobs`).

ALTER TABLE "custom_edge_types" DROP CONSTRAINT IF EXISTS "custom_edge_types_pkey";
--> statement-breakpoint
UPDATE "custom_edge_types" SET "tenant_id" = '' WHERE "tenant_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "custom_edge_types" ALTER COLUMN "tenant_id" SET DEFAULT '';
--> statement-breakpoint
ALTER TABLE "custom_edge_types" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "custom_edge_types" ADD CONSTRAINT "custom_edge_types_tenant_id_id_pk" PRIMARY KEY ("tenant_id", "id");
--> statement-breakpoint
DROP POLICY IF EXISTS "custom_edge_types_tenant_isolation" ON "custom_edge_types";
--> statement-breakpoint
CREATE POLICY "custom_edge_types_tenant_isolation" ON "custom_edge_types"
  FOR ALL TO "marfa_app"
  USING (tenant_id = current_setting('marfa.tenant_id', true)
         OR tenant_id = '');

-- TSC42 §1: rename `library: bool` → `tier: 'library' | 'feed'` on items, and
-- `default_library: bool` → `default_tier: 'library' | 'feed'` on api_keys.
-- In-place transform: add the new column, populate from the old one, drop the
-- old. Lossless: true → 'library', false → 'feed'.
ALTER TABLE "items" ADD COLUMN "tier" text NOT NULL DEFAULT 'library';--> statement-breakpoint
UPDATE "items" SET "tier" = CASE WHEN "library" THEN 'library' ELSE 'feed' END;--> statement-breakpoint
ALTER TABLE "items" DROP COLUMN "library";--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "default_tier" text NOT NULL DEFAULT 'library';--> statement-breakpoint
UPDATE "api_keys" SET "default_tier" = CASE WHEN "default_library" THEN 'library' ELSE 'feed' END;--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN "default_library";

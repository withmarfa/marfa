-- Wave 2 PR 4 commit 15: fine-grained edge permissions. See pg equivalent
-- for rationale; grandfathering runs identically.

ALTER TABLE `api_keys`
  ADD COLUMN `edge_permissions` text NOT NULL DEFAULT '{}';
--> statement-breakpoint
UPDATE `api_keys`
SET `edge_permissions` = '{"*":"write"}'
WHERE `role` != 'admin'
  AND `type_permissions` != '{}'
  AND `edge_permissions` = '{}';

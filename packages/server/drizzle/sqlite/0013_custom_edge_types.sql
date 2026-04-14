-- Wave 2 PR 4 commit 17: custom edge-type registration.

CREATE TABLE `custom_edge_types` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `schema` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);

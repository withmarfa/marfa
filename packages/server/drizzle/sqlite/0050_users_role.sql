-- T-178: users.role column. See pg/0058 for the full design note.
ALTER TABLE `users` ADD COLUMN `role` text NOT NULL DEFAULT 'member';

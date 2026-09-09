-- A credential with no space holds nothing.
--
-- The row constraint already says space-less and operator are the same set.
-- What nothing said is the other half of the model: running the instance is
-- not a permission, so the tier that runs it carries none. That was a
-- property of how the operator key happened to be minted rather than a rule
-- any door asked, and two doors could write past it -- `POST /keys` from an
-- operator caller, which mints into the caller's absent space, and
-- `PATCH /keys/{id}`, the only door that addresses a space-less row.
--
-- The storage layer applies no space predicate to a space-less caller, so a
-- single map entry on one of these rows is read or write across every space,
-- reached without a space ever being named. The code stops producing them in
-- the same change; this clears the ones an instance may already hold, because
-- a rule the code enforces and the data contradicts is not a rule.
--
-- Revoked rows are cleared too, and that is a trade rather than a tidy-up. A
-- revoked credential's stored maps are a record of what it could reach while
-- it was live, which is what an incident review would want. They are also the
-- weaker copy of that record: the audit trail already carries every mint and
-- every edit, with the fields each one touched, and it is immutable where a
-- column is not. What a column can do instead is make the next reader doubt
-- the rule, by leaving the estate holding a shape nothing can write any more.
UPDATE `api_keys`
SET `type_permissions`      = '{}',
    `edge_permissions`      = '{}',
    `metadata_permissions`  = '{}',
    `extension_permissions` = '{}',
    `profile_permissions`   = '{}',
    `space_permissions`     = '[]'
WHERE `space_id` IS NULL;

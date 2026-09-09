-- OAuth grant projections join the space their sign-in resolves to.
--
-- A `system.connection` row with `kind = 'app'` is the Marfa half of a grant:
-- the security page lists it, `DELETE /auth/grants/{id}` revokes through it,
-- and re-consent updates it in place. Which bucket it sits in has to match
-- the space a sign-in resolves, because the lookup that finds it reads
-- exactly one bucket.
--
-- `0105_keys_mode_gets_a_space` held these rows back, on the premise that a
-- keys-mode sign-in resolves no space and a projection therefore had nowhere
-- truthful to go. That premise is gone: a sign-in resolves a space in both
-- modes now, and the token minted for it carries the same space. A projection
-- left behind in the space-less bucket is invisible to the security page,
-- unreachable by the revoke door, absent from the audit row that names a
-- reused grant, and re-consent inserts a second row beside it rather than
-- updating it. Nothing errors in any of that.
--
-- **The target is what the runtime resolver answers, in both of its arms.**
-- The resolver branches on whether a `users` store is wired, which is hosted
-- mode: there, the space is the one on the consenting account's row and an
-- account with no row resolves nothing. Keys mode has no user store, and
-- there the space is the instance's only one.
--
-- **The second arm is gated on the table being empty, not on the first arm
-- missing.** A `COALESCE` alone reads "no account row, so fall through", and
-- that is a different question: on a hosted instance holding one space it
-- would sweep an orphan whose account is gone into a space belonging to
-- somebody else, and the security page lists a space's grants without
-- filtering by person, so that somebody would be shown an app they never
-- authorized and offered a button to disconnect it. `NOT EXISTS (SELECT 1
-- FROM users)` is the SQL spelling of "no user store": hosted always has
-- rows, keys mode never does.
--
-- Neither arm guesses. An instance answering neither keeps its rows where
-- they are, the same way issuance declines to bind a token it cannot place.
--
-- **A projection whose target space already holds a standing one for the same
-- app and person stays where it is.** That pair can exist where somebody
-- consented before their account had a space and again afterwards. Moving the
-- older row would put two active projections for one grant in one space, and
-- the lookup takes the first of them, so a revoke could end the record the
-- person is not looking at. The stale row confers nothing either way -- its
-- tokens carry no space and are refused on every request -- so leaving it
-- costs nothing and needs a person rather than a guess.
--
-- **Only the newest of several stranded rows for one pair moves.** The guard
-- below compares against the target space, and a single statement sees one
-- snapshot, so two space-less rows for the same app and person would both
-- move and land beside each other. The newest is the one a caller would have
-- been served, so it is the one that moves; the rest stay where they are,
-- under the paragraph above.
--
-- **Only a live row moves.** A projection soft-deleted through the type's
-- own lifecycle is invisible to every read surface, and the guard below
-- already ignores one, so moving it would be the one asymmetry in the
-- statement.
UPDATE "items" AS "orphan"
SET "space_id" = "resolved"."space_id"
FROM (
  SELECT
    "o"."id" AS "item_id",
    COALESCE(
      (SELECT "u"."space_id" FROM "users" AS "u"
        WHERE "u"."auth_user_id" = "o"."properties"->>'user_id'
        LIMIT 1),
      (SELECT "s"."id" FROM "spaces" AS "s"
        WHERE (SELECT COUNT(*) FROM "spaces") = 1
          AND NOT EXISTS (SELECT 1 FROM "users"))
    ) AS "space_id"
  FROM "items" AS "o"
  WHERE "o"."space_id" IS NULL
    AND "o"."state" = 'active'
    AND "o"."type" = 'system.connection'
    AND "o"."properties"->>'kind' = 'app'
) AS "resolved"
WHERE "orphan"."id" = "resolved"."item_id"
  AND "resolved"."space_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "items" AS "standing"
    WHERE "standing"."space_id" = "resolved"."space_id"
      AND "standing"."type" = 'system.connection'
      AND "standing"."state" = 'active'
      AND "standing"."properties"->>'kind' = 'app'
      AND "standing"."properties"->>'client_id' = "orphan"."properties"->>'client_id'
      AND "standing"."properties"->>'user_id' = "orphan"."properties"->>'user_id'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "items" AS "newer"
    WHERE "newer"."space_id" IS NULL
      AND "newer"."state" = 'active'
      AND "newer"."type" = 'system.connection'
      AND "newer"."properties"->>'kind' = 'app'
      AND "newer"."properties"->>'client_id' = "orphan"."properties"->>'client_id'
      AND "newer"."properties"->>'user_id' = "orphan"."properties"->>'user_id'
      AND "newer"."id" > "orphan"."id"
  );

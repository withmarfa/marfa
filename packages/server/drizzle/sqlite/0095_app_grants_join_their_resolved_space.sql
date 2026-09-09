-- OAuth grant projections join the space their sign-in resolves to.
--
-- A `system.connection` row with `kind = 'app'` is the Marfa half of a grant:
-- the security page lists it, `DELETE /auth/grants/{id}` revokes through it,
-- and re-consent updates it in place. Which bucket it sits in has to match
-- the space a sign-in resolves, because the lookup that finds it reads
-- exactly one bucket.
--
-- `0091_keys_mode_gets_a_space` held these rows back, on the premise that a
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
-- authorized and offered a button to disconnect it.
--
-- `NOT EXISTS (SELECT 1 FROM users)` stands in for "no user store", and the
-- substitution is worth naming rather than assuming. The runtime reads
-- configuration: the store is wired in hosted mode and absent in keys mode. A
-- migration has no configuration to read, so it asks the rows instead, and
-- the two answers part on two shapes. A hosted instance whose accounts have
-- all been deleted, holding one space, takes the sole-space arm; a keys-mode
-- instance carrying rows from an earlier hosted life takes the account arm
-- the runtime there never consults. Both are narrow and neither is
-- impossible, so read this as what the estate looks like rather than as an
-- invariant something enforces.
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
-- move and land beside each other. The newest carries the most recent
-- consent, so it is the one that moves and the rest stay where they are,
-- under the paragraph above. Not because it is the one a caller was served:
-- the lookup has no ordering and takes an arbitrary row, which is the reason
-- two of them in one space is the shape to avoid rather than a tie-break to
-- reproduce here. `id` is time-sortable, so comparing it orders by age.
--
-- **Only a live row moves.** A projection soft-deleted through the type's
-- own lifecycle is invisible to every read surface, and the guard below
-- already ignores one, so moving it would be the one asymmetry in the
-- statement.
--
-- **A consent during the deploy window lands behind the sweep.** Migrations
-- run before the stack rolls, so the old build goes on resolving keys-mode
-- sign-ins to no space for as long as the roll takes, and a projection
-- written in that window is space-less with this statement already past. It
-- is one inert orphan rather than a duplicate inside a space: the next
-- re-consent resolves the space, finds the row that moved and updates that
-- one. Re-running this statement is the repair if anybody wants the orphan
-- gone.
UPDATE `items` AS `orphan`
SET `space_id` = `resolved`.`space_id`
FROM (
  SELECT
    `o`.`id` AS `item_id`,
    COALESCE(
      (SELECT `u`.`space_id` FROM `users` AS `u`
        WHERE `u`.`auth_user_id` = json_extract(`o`.`properties`, '$.user_id')
        LIMIT 1),
      (SELECT `s`.`id` FROM `spaces` AS `s`
        WHERE (SELECT COUNT(*) FROM `spaces`) = 1
          AND NOT EXISTS (SELECT 1 FROM `users`))
    ) AS `space_id`
  FROM `items` AS `o`
  WHERE `o`.`space_id` IS NULL
    AND `o`.`state` = 'active'
    AND `o`.`type` = 'system.connection'
    AND json_extract(`o`.`properties`, '$.kind') = 'app'
) AS `resolved`
WHERE `orphan`.`id` = `resolved`.`item_id`
  AND `resolved`.`space_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `items` AS `standing`
    WHERE `standing`.`space_id` = `resolved`.`space_id`
      AND `standing`.`type` = 'system.connection'
      AND `standing`.`state` = 'active'
      AND json_extract(`standing`.`properties`, '$.kind') = 'app'
      AND json_extract(`standing`.`properties`, '$.client_id')
          = json_extract(`orphan`.`properties`, '$.client_id')
      AND json_extract(`standing`.`properties`, '$.user_id')
          = json_extract(`orphan`.`properties`, '$.user_id')
  )
  AND NOT EXISTS (
    SELECT 1 FROM `items` AS `newer`
    WHERE `newer`.`space_id` IS NULL
      AND `newer`.`state` = 'active'
      AND `newer`.`type` = 'system.connection'
      AND json_extract(`newer`.`properties`, '$.kind') = 'app'
      AND json_extract(`newer`.`properties`, '$.client_id')
          = json_extract(`orphan`.`properties`, '$.client_id')
      AND json_extract(`newer`.`properties`, '$.user_id')
          = json_extract(`orphan`.`properties`, '$.user_id')
      AND `newer`.`id` > `orphan`.`id`
  );

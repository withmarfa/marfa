-- OAuth grant projections join the space their sign-in now resolves to.
--
-- A `system.connection` row with `kind = 'app'` is the Marfa half of a grant:
-- the security page lists it, `DELETE /auth/grants/{id}` revokes through it,
-- and re-consent updates it in place. Which bucket it sits in has to match
-- the space a sign-in resolves, because the lookup that finds it reads
-- exactly one bucket.
--
-- `0091_keys_mode_gets_a_space` held these rows back, on the premise that a
-- keys-mode sign-in resolves no space and a projection therefore had nowhere
-- truthful to go. That premise is gone: a sign-in on a keys-mode instance
-- resolves the instance's one space, and the token minted for it carries that
-- space too. A projection left behind in the space-less bucket is invisible
-- to the security page, unreachable by the revoke door, absent from the audit
-- row that names a reused grant, and re-consent inserts a second row beside
-- it rather than updating it. Nothing errors in any of that.
--
-- **Gated on the instance holding exactly one space, which is the same
-- question issuance asks.** `resolveSpaceIdForAuthUser` answers a keys-mode
-- sign-in with the sole space and answers nothing where there is any other
-- number, so a migration moving rows on a looser condition would put them
-- somewhere the runtime then declines to look. On a hosted instance with
-- tenants this matches nothing and writes nothing.
--
-- **A projection whose space already holds a standing one for the same app
-- and person stays where it is.** That pair can exist where a person
-- consented before their account had a space and again afterwards. Moving
-- the older row would put two active projections for one grant in one space,
-- and the lookup takes the first of them, so a revoke could end the record
-- the person is not looking at. The stale row confers nothing either way --
-- its tokens carry no space and are refused on every request -- so leaving it
-- costs nothing and needs a person rather than a guess.
UPDATE `items`
SET `space_id` = (SELECT `id` FROM `spaces` LIMIT 1)
WHERE `items`.`space_id` IS NULL
  AND `items`.`type` = 'system.connection'
  AND json_extract(`items`.`properties`, '$.kind') = 'app'
  AND (SELECT COUNT(*) FROM `spaces`) = 1
  AND NOT EXISTS (
    SELECT 1 FROM `items` AS `standing`
    WHERE `standing`.`space_id` = (SELECT `id` FROM `spaces` LIMIT 1)
      AND `standing`.`type` = 'system.connection'
      AND `standing`.`state` = 'active'
      AND json_extract(`standing`.`properties`, '$.kind') = 'app'
      AND json_extract(`standing`.`properties`, '$.client_id')
          = json_extract(`items`.`properties`, '$.client_id')
      AND json_extract(`standing`.`properties`, '$.user_id')
          = json_extract(`items`.`properties`, '$.user_id')
  );

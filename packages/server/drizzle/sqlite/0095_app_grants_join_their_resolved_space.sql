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
-- With a `users` row for the consenting account it is that account's space,
-- which is the hosted answer and the one that reaches an instance holding
-- many spaces. Without one it is the instance's only space, which is the
-- keys-mode answer, and it is deliberately not a guess: an instance holding
-- any other number resolves nothing and keeps its rows where they are, the
-- same way issuance declines to bind a token it cannot place.
--
-- **A projection whose target space already holds a standing one for the same
-- app and person stays where it is.** That pair can exist where somebody
-- consented before their account had a space and again afterwards. Moving the
-- older row would put two active projections for one grant in one space, and
-- the lookup takes the first of them, so a revoke could end the record the
-- person is not looking at. The stale row confers nothing either way -- its
-- tokens carry no space and are refused on every request -- so leaving it
-- costs nothing and needs a person rather than a guess.
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
        WHERE (SELECT COUNT(*) FROM `spaces`) = 1)
    ) AS `space_id`
  FROM `items` AS `o`
  WHERE `o`.`space_id` IS NULL
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
  );

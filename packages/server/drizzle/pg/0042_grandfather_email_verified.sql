-- Wave C PR2: grandfather pre-existing accounts so `requireEmailVerification`
-- doesn't lock them out.
--
-- The `auth_user.email_verified` column has existed since the
-- better-auth schema bootstrap; PR1 left its default at `false`. Wave C
-- PR2 flips `requireEmailVerification: true` on the auth instance,
-- which would deny sign-in to every account created before this PR.
-- This one-shot UPDATE marks every existing row as verified at deploy
-- time. New sign-ups (`created_at >= NOW()` at migration time) are
-- not affected — they still get `email_verified = false` until the
-- user clicks the verification link.
--
-- The cutoff is `NOW()` at migration time, not a hard-coded date,
-- because a fresh deploy will have already run the migration before
-- any new sign-up arrives.
UPDATE "auth_user"
SET "email_verified" = TRUE
WHERE "created_at" < NOW();

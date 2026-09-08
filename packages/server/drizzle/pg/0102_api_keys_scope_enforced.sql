-- A key minted through an OAuth session is held to its permission maps rather
-- than to its role. The column exists so that stays true after the mint: the
-- breadth clamp at `POST /keys` narrows the maps to what the session's grant
-- covers, and a key whose role bypassed those maps would ignore the narrowing
-- at every subsequent request.
--
-- Default false, so every existing key keeps the behavior it was minted with.
ALTER TABLE "api_keys" ADD COLUMN "scope_enforced" boolean DEFAULT false NOT NULL;

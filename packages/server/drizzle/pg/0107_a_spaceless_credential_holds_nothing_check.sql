-- The database says a space-less credential holds nothing.
--
-- The one model has two halves about the instance tier and the database held
-- one of them. `api_keys_operator_iff_space_less` says a space-less key is the
-- operator key and nothing else. That running the instance is not a permission,
-- and so the tier that runs it carries none, was enforced at two doors in
-- `routes/keys.ts` and asserted once by 0106, and a rule with no structural
-- form is what let those two doors write past it for months in the first
-- place. This is the second half in the shape the first one has.
--
-- Every mint path and every fixture already complies and 0106 cleared the rows
-- that did not, so this refuses nothing that exists. It is worth adding for the
-- reason the first half was: a rule the database holds cannot be reintroduced
-- by a route somebody adds without reading the one that came before.
--
-- **Literal comparison, not a semantic one.** The columns are `text` on both
-- dialects and both stores write them through `JSON.stringify`, so `{}` and
-- `[]` are the exact bytes an empty map and an empty list take. Comparing the
-- bytes is what keeps the two dialects saying the same thing.
--
-- **Added unvalidated, then validated, because that is the shape that lets the
-- scan run under a weaker lock.** `ADD CONSTRAINT ... NOT VALID` records the
-- rule without reading a row, and `VALIDATE CONSTRAINT` then reads every row
-- holding SHARE UPDATE EXCLUSIVE, which admits concurrent reads and writes
-- where the single-statement form holds ACCESS EXCLUSIVE across the whole
-- scan. One caveat, because it changes what the split buys today: the
-- migration runner brackets the entire chain in one transaction, so the
-- exclusive lock the first statement takes is held until that transaction
-- commits and the weaker lock is only reached when the pair is applied outside
-- it. The split costs nothing either way and is the shape that is right when
-- the bracket goes.
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_space_less_holds_nothing"
  CHECK ("space_id" IS NOT NULL OR (
    "type_permissions"      = '{}'  AND
    "edge_permissions"      = '{}'  AND
    "metadata_permissions"  = '{}'  AND
    "extension_permissions" = '{}'  AND
    "profile_permissions"   = '{}'  AND
    "space_permissions"     = '[]')) NOT VALID;--> statement-breakpoint
ALTER TABLE "api_keys" VALIDATE CONSTRAINT "api_keys_space_less_holds_nothing";

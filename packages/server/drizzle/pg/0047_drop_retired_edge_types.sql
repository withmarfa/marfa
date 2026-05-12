-- T-108: edges rework.
--
-- `pinned-to` collapses into `parent-of` — group membership is just a
-- parent/child relationship, and the name was importing a UI gesture
-- ("pin to a collection") into the data model.
--
-- `annotates` is replaced by `references` — overlapping boundary with
-- `about`; `references` covers the canonical case (a core.highlight
-- referencing a passage) and is named more honestly.
--
-- Existing rows of the retired types are deleted. Pre-release, no
-- consumer reads them; rename-in-place would lie about the semantics
-- (cardinality differs between pinned-to and parent-of). Clean break.

DELETE FROM "edges" WHERE "edge_type" IN ('pinned-to', 'annotates');

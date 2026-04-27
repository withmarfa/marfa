-- TSC42 §3/§4: platform-credential gate. The `is_platform` flag on api_keys
-- distinguishes the seed install credential (and any others minted from it)
-- from ordinary admin/member keys. Used to gate registration and writes of
-- core.* / system.* / myme.* types.
--
-- Defaults to false; the bootstrap install path sets it to true on the very
-- first credential created. Once seeded, only an existing platform credential
-- may mint another.
ALTER TABLE "api_keys" ADD COLUMN "is_platform" boolean NOT NULL DEFAULT false;

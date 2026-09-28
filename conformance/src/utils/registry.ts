import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A folder registry of the run's own (`folders.md` 38), named in
 * `MARFA_FOLDER_REGISTRY` for every binary the run starts, so no folder added
 * under test is listed in the person's own registry. The `device` and `cli`
 * projects make it in their global setup and remove it in its teardown.
 */
export default function makeRegistry(): () => void {
  const folder = mkdtempSync(join(tmpdir(), "marfa-conformance-registry-"));
  process.env.MARFA_FOLDER_REGISTRY = join(folder, "folders.json");
  return () => {
    rmSync(folder, { recursive: true, force: true });
  };
}

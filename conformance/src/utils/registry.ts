import { join } from "node:path";
import { removeTempFolder, tempFolder } from "./temp-folder.js";

/**
 * A folder registry of the run's own (`folder-setup/registry-location`), named in
 * `MARFA_FOLDER_REGISTRY` for every binary the run starts, so no folder added
 * under test is listed in the person's own registry. The `device` and `cli`
 * projects make it in their global setup and remove it in its teardown.
 */
export default function makeRegistry(): () => void {
  const folder = tempFolder("marfa-conformance-registry-");
  process.env.MARFA_FOLDER_REGISTRY = join(folder, "folders.json");
  return () => {
    removeTempFolder(folder);
  };
}

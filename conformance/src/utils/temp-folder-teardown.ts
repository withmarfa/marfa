import { afterAll } from "vitest";
import { removeTempFolders } from "./temp-folder.js";

// Runs after the file's own hooks, however its tests ended, so the next file
// in this process starts with nothing of this one's.
afterAll(removeTempFolders, 60_000);

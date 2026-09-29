import { afterAll } from "vitest";
import { FRESH_SERVER_TIMEOUT_MS, stopFreshServers } from "./fresh-server.js";

// A boot that outlived its hook's timeout still brings a server up, and
// nothing in the file holds it to stop. Room to wait out that boot, then stop.
afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

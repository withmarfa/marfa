import { registerHandlers } from "./handlers.js";
import { RAINDROP_MANIFEST } from "./manifest.js";

registerHandlers();

export { RAINDROP_MANIFEST as manifest };
export { registerHandlers };

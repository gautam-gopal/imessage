// Must be the FIRST local import of src/index.js. ES modules evaluate imports
// in order, so this loads .env and validates it before modules that need env
// at import time (lib/imagekit.js throws without its key; lib/socket.js reads
// FRONTEND_URL) are evaluated.
import "dotenv/config";
import { validateEnv } from "./env.js";

try {
  validateEnv();
} catch (error) {
  console.error(`[env] ${error.message}`);
  process.exit(1);
}

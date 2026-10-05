// Environment contract for the backend. Pure (no side effects on import) so it
// can be unit-tested; lib/load-env.js is the side-effecting entry that runs it.

// Without these the app cannot serve its core function. Missing in
// production = refuse to start (fail fast, readable error) instead of booting
// into a half-working state. In development they only produce a warning, so
// local setups are not newly blocked.
export const REQUIRED_IN_PRODUCTION = [
  "MONGO_URI",
  "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY", // read implicitly by @clerk/express
  "IMAGEKIT_PRIVATE_KEY",
  "FRONTEND_URL", // CORS origin + keep-alive self-ping target (lib/cron.js)
];

// The app starts without these, but a feature silently stops working.
export const RECOMMENDED = {
  CLERK_WEBHOOK_SIGNING_SECRET:
    "Clerk webhook returns 503; users will not sync",
  OPENAI_API_KEY: "the @nextalk assistant will report 'unavailable'",
};

const isBlank = (value) => typeof value !== "string" || value.trim() === "";

export function validateEnv(env = process.env, logger = console) {
  const isProduction = env.NODE_ENV === "production";

  const missing = REQUIRED_IN_PRODUCTION.filter((key) => isBlank(env[key]));
  const warnings = Object.entries(RECOMMENDED)
    .filter(([key]) => isBlank(env[key]))
    .map(([key, effect]) => `${key} is not set: ${effect}`);

  if (missing.length > 0) {
    const message = `Missing required environment variables: ${missing.join(", ")}`;
    if (isProduction) throw new Error(message);
    logger.warn(`[env] ${message} (continuing: NODE_ENV is not production)`);
  }

  for (const warning of warnings) logger.warn(`[env] ${warning}`);

  return { missing, warnings };
}

// An unset PORT previously made server.listen(undefined) bind a random port.
// 3000 matches the frontend's development URLs.
export function getPort(env = process.env) {
  const port = Number(env.PORT);
  return Number.isInteger(port) && port > 0 ? port : 3000;
}

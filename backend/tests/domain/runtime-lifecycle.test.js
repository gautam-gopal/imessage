import { afterEach, describe, expect, it, vi } from "vitest";
import { getPort, validateEnv } from "../../src/lib/env.js";
import { createShutdown } from "../../src/lib/shutdown.js";

const fullEnv = {
  NODE_ENV: "production",
  MONGO_URI: "mongodb://x",
  CLERK_SECRET_KEY: "sk",
  CLERK_PUBLISHABLE_KEY: "pk",
  IMAGEKIT_PRIVATE_KEY: "ik",
  FRONTEND_URL: "https://app.example.com",
  CLERK_WEBHOOK_SIGNING_SECRET: "whsec",
  OPENAI_API_KEY: "key",
};

const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("validateEnv", () => {
  it("accepts a complete production environment", () => {
    const result = validateEnv(fullEnv, quiet);
    expect(result).toEqual({ missing: [], warnings: [] });
  });

  it("throws in production and names every missing required variable", () => {
    const env = { ...fullEnv, MONGO_URI: "", CLERK_SECRET_KEY: "   " };
    delete env.FRONTEND_URL;
    expect(() => validateEnv(env, quiet)).toThrow(
      /MONGO_URI, CLERK_SECRET_KEY, FRONTEND_URL/,
    );
  });

  it("only warns outside production", () => {
    const logger = { ...quiet, warn: vi.fn() };
    const result = validateEnv({ NODE_ENV: "development" }, logger);
    expect(result.missing.length).toBeGreaterThan(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("warns, but does not throw, for optional features in production", () => {
    const env = { ...fullEnv };
    delete env.OPENAI_API_KEY;
    const result = validateEnv(env, quiet);
    expect(result.missing).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });
});

describe("getPort", () => {
  it("uses PORT when valid and falls back to 3000 otherwise", () => {
    expect(getPort({ PORT: "10000" })).toBe(10000);
    expect(getPort({})).toBe(3000);
    expect(getPort({ PORT: "abc" })).toBe(3000);
    expect(getPort({ PORT: "0" })).toBe(3000);
  });
});

describe("createShutdown", () => {
  afterEach(() => vi.useRealTimers());

  const build = (overrides = {}) => {
    const calls = [];
    const exit = vi.fn();
    const deps = {
      stopJobs: vi.fn(() => calls.push("jobs")),
      closeServer: vi.fn(async () => calls.push("server")),
      closeDb: vi.fn(async () => calls.push("db")),
      exit,
      logger: quiet,
      ...overrides,
    };
    return { calls, exit, deps, ...createShutdown(deps) };
  };

  it("stops jobs, then the server, then the DB, then exits 0", async () => {
    const { calls, exit, shutdown, isShuttingDown } = build();
    expect(isShuttingDown()).toBe(false);
    await shutdown("SIGTERM");
    expect(calls).toEqual(["jobs", "server", "db"]);
    expect(exit).toHaveBeenCalledWith(0);
    expect(isShuttingDown()).toBe(true);
  });

  it("is idempotent across repeated signals", async () => {
    const { deps, exit, shutdown } = build();
    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
    expect(deps.closeServer).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("still closes the DB and exits 1 when closing the server fails", async () => {
    const { deps, exit, shutdown } = build({
      closeServer: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await shutdown("SIGTERM");
    expect(deps.closeDb).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("forces exit(1) if closing hangs past the timeout", async () => {
    vi.useFakeTimers();
    const { exit, shutdown } = build({
      closeServer: () => new Promise(() => {}),
      timeoutMs: 5000,
    });
    shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(5000);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

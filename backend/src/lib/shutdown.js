// Graceful shutdown coordinator. Dependencies are injected so the ordering,
// idempotency and timeout behaviour can be tested without real signals.
//
// Order: stop background jobs -> close Socket.IO + HTTP server (stops new
// connections, disconnects sockets so clients reconnect elsewhere) -> close
// the MongoDB connection -> exit. A hard timeout guarantees the process
// cannot hang forever on a stuck connection.
export function createShutdown({
  closeServer,
  closeDb,
  stopJobs = () => {},
  timeoutMs = 10_000,
  exit = process.exit,
  logger = console,
}) {
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`[shutdown] ${signal} received, shutting down`);

    const timer = setTimeout(() => {
      logger.error(
        `[shutdown] not finished after ${timeoutMs}ms, forcing exit`,
      );
      exit(1);
    }, timeoutMs);
    timer.unref?.();

    let exitCode = 0;

    try {
      stopJobs();
      await closeServer();
    } catch (error) {
      exitCode = 1;
      logger.error("[shutdown] error closing server:", error?.message ?? error);
    }

    // Always attempt to close the DB, even if closing the server failed.
    try {
      await closeDb();
    } catch (error) {
      exitCode = 1;
      logger.error(
        "[shutdown] error closing database:",
        error?.message ?? error,
      );
    }

    clearTimeout(timer);
    logger.log("[shutdown] complete");
    exit(exitCode);
  }

  return { shutdown, isShuttingDown: () => shuttingDown };
}

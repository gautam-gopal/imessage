import multer from "multer";

export function errorHandler(err, req, res, next) {
  // 1. Multer's own error type
  if (err instanceof multer.MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({ message: multerMessage(err) });
  }

  // 2. Anything else intentionally marked as a client-facing error
  if (err.statusCode) {
    return res.status(err.statusCode).json({ message: err.message });
  }

  // 3. Unexpected / programming error — never leak details to the client
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "Internal server error" });
}

function multerMessage(err) {
  switch (err.code) {
    case "LIMIT_FILE_SIZE":
      return "File is too large.";
    case "LIMIT_UNEXPECTED_FILE":
      return "Unexpected file field.";
    default:
      return "File upload error.";
  }
}

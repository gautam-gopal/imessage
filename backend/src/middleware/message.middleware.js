import User from "../models/user.model.js";

export async function requireReceiverExists(req, res, next) {
  try {
    const exists = await User.exists({ _id: req.params.id });

    if (!exists) {
      const err = new Error("Receiver not found");
      err.statusCode = 404;
      return next(err);
    }

    next();
  } catch (error) {
    next(error);
  }
}

export function requireTextOrFile(req, res, next) {
  const hasText =
    typeof req.body?.text === "string" && req.body.text.trim().length > 0;

  const hasFile = Boolean(req.file);

  if (!hasText && !hasFile) {
    const err = new Error("Message must include text or a file");
    err.statusCode = 400;
    return next(err);
  }

  next();
}

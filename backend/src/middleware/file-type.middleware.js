import { fileTypeFromBuffer } from "file-type";

export async function verifyFileType(req, res, next) {
  try {
    if (!req.file) {
      return next();
    }

    const detected = await fileTypeFromBuffer(req.file.buffer);

    if (
      !detected ||
      (!detected.mime.startsWith("image/") &&
        !detected.mime.startsWith("video/"))
    ) {
      const err = new Error("Unsupported or invalid media file");
      err.statusCode = 415;
      return next(err);
    }

    req.file.mimetype = detected.mime;

    next();
  } catch (error) {
    next(error);
  }
}

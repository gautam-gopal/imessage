import multer from "multer";

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25mb

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const isImage = file.mimetype.startsWith("image/");
    const isVideo = file.mimetype.startsWith("video/");

    if (!isImage && !isVideo) {
      const err = new Error("Only image and video uploads are allowed");
      err.statusCode = 415; // Unsupported Media Type
      cb(err);
      return;
    }

    cb(null, true);
  },
});

import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Only the ImageKit network call is replaced. Routing, auth, membership,
// Multer, verifyFileType, the controllers and the global error handler are
// all the production code. `uploadChatMedia` also records the mimetype the
// controller hands it, i.e. what verifyFileType decided the file really is.
vi.mock("../../src/lib/imagekit.js", () => ({
  hasImageKitConfig: () => true,
  uploadChatMedia: vi.fn(),
}));

import { uploadChatMedia } from "../../src/lib/imagekit.js";
import Message from "../../src/models/message.model.js";
import Conversation from "../../src/models/conversation.model.js";
import { errorHandler } from "../../src/middleware/error.middleware.js";
import { api, createUser, createGroup } from "../helpers/factories.js";
import { PNG, GIF, JPEG, MP4, PDF, SVG, HTML, PLAIN_TEXT } from "../helpers/media-fixtures.js";

const MAX_FILE_SIZE = 25 * 1024 * 1024;

beforeEach(() => {
  uploadChatMedia.mockReset();
  uploadChatMedia.mockImplementation(
    async (file) => `https://ik.test/${file.mimetype.replace("/", "_")}`,
  );
});
afterEach(() => vi.restoreAllMocks());

async function directPair() {
  const [a, b] = [await createUser(), await createUser()];
  return { a, b, url: `/api/messages/send/${b._id}` };
}
const attach = (req, buffer, { field = "media", filename = "file", contentType } = {}) =>
  req.attach(field, buffer, { filename, contentType });

describe("magic-byte verification on the real send route", () => {
  it.each([
    ["PNG", PNG, "image/png"],
    ["GIF", GIF, "image/gif"],
    ["JPEG", JPEG, "image/jpeg"],
  ])("accepts genuine %s and stores it as an image", async (_n, buffer, mime) => {
    const { a, url } = await directPair();

    const res = await attach(api(a).post(url), buffer, { contentType: mime });

    expect(res.status).toBe(201);
    expect(res.body.image).toBe(`https://ik.test/${mime.replace("/", "_")}`);
    expect(res.body.video).toBeUndefined();
    expect(await Message.countDocuments({})).toBe(1);
  });

  it("accepts genuine MP4 and stores it as a video", async () => {
    const { a, url } = await directPair();

    const res = await attach(api(a).post(url), MP4, { contentType: "video/mp4" });

    expect(res.status).toBe(201);
    expect(res.body.video).toBe("https://ik.test/video_mp4");
    expect(res.body.image).toBeUndefined();
  });

  it("trusts the bytes, not the label: PNG bytes declared as video are handled as an image", async () => {
    const { a, url } = await directPair();

    const res = await attach(api(a).post(url), PNG, { contentType: "video/mp4", filename: "x.mp4" });

    expect(res.status).toBe(201);
    expect(uploadChatMedia.mock.calls[0][0].mimetype).toBe("image/png");
    expect(res.body.image).toBeTruthy();
    expect(res.body.video).toBeUndefined();
  });

  it.each([
    ["PDF bytes labelled image/png", PDF, "image/png"],
    ["PDF bytes labelled video/mp4", PDF, "video/mp4"],
    ["SVG (image/svg+xml, script-capable)", SVG, "image/svg+xml"],
    ["SVG labelled image/png", SVG, "image/png"],
    ["HTML labelled image/jpeg", HTML, "image/jpeg"],
    ["plain text labelled image/png", PLAIN_TEXT, "image/png"],
    ["empty file labelled image/png", Buffer.alloc(0), "image/png"],
  ])("rejects %s with 415 before any upload or write", async (_n, buffer, mime) => {
    const { a, url } = await directPair();

    const res = await attach(api(a).post(url), buffer, { contentType: mime });

    expect(res.status).toBe(415);
    expect(res.body).toEqual({ message: "Unsupported or invalid media file" });
    expect(uploadChatMedia).not.toHaveBeenCalled();
    expect(await Message.countDocuments({})).toBe(0);
    expect(await Conversation.countDocuments({})).toBe(0);
  });

  it("rejects a declared non-image/video type before reading the content", async () => {
    const { a, url } = await directPair();

    const res = await attach(api(a).post(url), PNG, { contentType: "application/pdf" });

    expect(res.status).toBe(415);
    expect(res.body).toEqual({ message: "Only image and video uploads are allowed" });
    expect(uploadChatMedia).not.toHaveBeenCalled();
    expect(await Message.countDocuments({})).toBe(0);
  });

  it("applies the same verification on the group send route", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const group = await createGroup(a, [b]);
    const url = `/api/conversations/${group._id}/messages`;

    const bad = await attach(api(a).post(url), PDF, { contentType: "image/png" });
    expect(bad.status).toBe(415);
    expect(await Message.countDocuments({})).toBe(0);

    const good = await attach(api(a).post(url), PNG, { contentType: "image/png" });
    expect(good.status).toBe(201);
    expect(good.body.image).toBeTruthy();
    expect(String(good.body.conversationId)).toBe(String(group._id));
  });
});

describe("Multer limits through the global error handler", () => {
  it("rejects a file over 25 MB with 413 and writes nothing", async () => {
    const { a, url } = await directPair();
    const tooBig = Buffer.concat([PNG, Buffer.alloc(MAX_FILE_SIZE)]);

    const res = await attach(api(a).post(url), tooBig, { contentType: "image/png" });

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ message: "File is too large." });
    expect(uploadChatMedia).not.toHaveBeenCalled();
    expect(await Message.countDocuments({})).toBe(0);
  });

  it("accepts a file of exactly 25 MB", async () => {
    const { a, url } = await directPair();
    const exact = Buffer.concat([PNG, Buffer.alloc(MAX_FILE_SIZE - PNG.length)]);

    const res = await attach(api(a).post(url), exact, { contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(uploadChatMedia.mock.calls[0][0].size).toBe(MAX_FILE_SIZE);
  });

  it("rejects an unexpected multipart file field with 400", async () => {
    const { a, url } = await directPair();

    const res = await attach(api(a).post(url), PNG, { field: "avatar", contentType: "image/png" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: "Unexpected file field." });
    expect(uploadChatMedia).not.toHaveBeenCalled();
    expect(await Message.countDocuments({})).toBe(0);
  });

  it("enforces the size limit on the group route too", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const group = await createGroup(a, [b]);

    const res = await attach(
      api(a).post(`/api/conversations/${group._id}/messages`),
      Buffer.concat([PNG, Buffer.alloc(MAX_FILE_SIZE)]),
      { contentType: "image/png" },
    );

    expect(res.status).toBe(413);
    expect(await Message.countDocuments({})).toBe(0);
  });
});

describe("unexpected server errors do not leak internals", () => {
  const SECRET = "ImageKit key sk_live_abc123 at /srv/app/src/lib/imagekit.js:42";

  it("a failing upload on the real route yields a generic 500 and no message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    uploadChatMedia.mockRejectedValue(new Error(SECRET));
    const { a, url } = await directPair();

    const res = await attach(api(a).post(url), PNG, { contentType: "image/png" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: "Internal server error" });
    expect(res.text).not.toContain("sk_live");
    expect(res.text).not.toContain("/srv/app");
    expect(await Message.countDocuments({})).toBe(0);
  });

  // No real route lets a non-Multer, non-statusCode error reach the global
  // handler, so its fallback branch is exercised on a two-route app that uses
  // the production errorHandler.
  const handlerApp = express();
  handlerApp.post("/boom", (req, res, next) => next(new Error(SECRET)));
  handlerApp.post("/client", (req, res, next) => {
    const err = new Error("Deliberate client error");
    err.statusCode = 422;
    next(err);
  });
  handlerApp.use(errorHandler);

  it("global handler: unexpected error -> generic 500, no message, stack or path", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(handlerApp).post("/boom");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: "Internal server error" });
    expect(res.text).not.toContain("sk_live");
    expect(res.text).not.toContain("/srv/app");
    expect(res.text).not.toMatch(/\bat\s.+\(/); // no stack frames
  });

  it("global handler: an error carrying statusCode keeps its status and message", async () => {
    const res = await request(handlerApp).post("/client");
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ message: "Deliberate client error" });
  });
});

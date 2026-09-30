// Smallest byte sequences that file-type recognises. The signature is all the
// middleware looks at, which is exactly what these tests need to control.
const b64 = (s) => Buffer.from(s, "base64");

export const PNG = b64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
);
export const GIF = b64("R0lGODlhAQABAAAAACw=");
export const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
]);
// ISO-BMFF "ftyp" box with the mp42 brand.
export const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftypmp42", "ascii"),
  Buffer.alloc(4),
  Buffer.from("mp42isom", "ascii"),
]);

// Things that must never be accepted as chat media, whatever the client says.
export const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n", "ascii");
export const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  "utf8",
);
export const HTML = Buffer.from("<html><script>alert(1)</script></html>", "utf8");
export const PLAIN_TEXT = Buffer.from("just some text, not an image", "utf8");

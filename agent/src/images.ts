// Byte-level validation and provenance for investigation images (Feature 4).
// Image contents are untrusted: we check real file signatures and dimensions, never
// trust the declared MIME type alone, and never fetch any URL.
import { createHash, randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION, type ImageInput, type ImageProvenance } from "./schemas.js";

export class ImageValidationError extends Error {}

export interface AcceptedImage {
  provenance: ImageProvenance;
  /** data: URL for the model's image_url content part. Never persisted. */
  dataUrl: string;
}

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function jpegSize(b: Buffer): { width: number; height: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  // Truncated JPEGs lack the End-Of-Image marker near the end.
  if (b.subarray(Math.max(0, b.length - 64)).indexOf(Buffer.from([0xff, 0xd9])) === -1) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; }
    const len = b.readUInt16BE(i + 2);
    // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function pngSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 33 || !b.subarray(0, 8).equals(PNG_SIG) || b.toString("ascii", 12, 16) !== "IHDR") return null;
  if (b.subarray(Math.max(0, b.length - 32)).indexOf(Buffer.from("IEND")) === -1) return null; // truncated
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** Exact inflated size a PNG must have: one filter byte per scanline, Adam7 passes if interlaced. */
function pngExpectedBytes(w: number, h: number, bitDepth: number, colorType: number, interlaced: boolean): number {
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels) throw new Error(`invalid color type ${colorType}`);
  const row = (pw: number) => (pw === 0 ? 0 : 1 + Math.ceil((pw * channels * bitDepth) / 8));
  if (!interlaced) return h * row(w);
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  return passes.reduce((sum, [x0, y0, dx, dy]) => {
    const pw = Math.ceil(Math.max(0, w - x0) / dx), ph = Math.ceil(Math.max(0, h - y0) / dy);
    return sum + (pw && ph ? ph * row(pw) : 0);
  }, 0);
}

function checkPngStream(b: Buffer) {
  const idat: Buffer[] = [];
  for (let i = 8; i + 8 <= b.length; ) {
    const len = b.readUInt32BE(i), type = b.toString("ascii", i + 4, i + 8);
    if (i + 12 + len > b.length) throw new Error("chunk extends past end of file");
    if (type === "IDAT") idat.push(b.subarray(i + 8, i + 8 + len));
    if (type === "IEND") break;
    i += 12 + len;
  }
  if (!idat.length) throw new Error("no image data (IDAT)");
  const inflated = inflateSync(Buffer.concat(idat));
  const expected = pngExpectedBytes(b.readUInt32BE(16), b.readUInt32BE(20), b[24], b[25], b[28] === 1);
  if (inflated.length !== expected) throw new Error(`image data is ${inflated.length} bytes; ${expected} expected`);
}

/** Walk JPEG segments; a decodable image needs a frame header followed by a scan with entropy data. */
function checkJpegStream(b: Buffer) {
  let i = 2, sawFrame = false;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new Error("invalid segment marker");
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd9) break;
    if (marker >= 0xd0 && marker <= 0xd7) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) throw new Error("segment extends past end of file");
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) sawFrame = true;
    if (marker === 0xda) {
      if (!sawFrame) throw new Error("scan before frame header");
      const dataStart = i + 2 + len;
      const eoi = b.lastIndexOf(Buffer.from([0xff, 0xd9]));
      if (eoi - dataStart < 2) throw new Error("scan has no image data");
      return;
    }
    i += 2 + len;
  }
  throw new Error("no image scan (SOS)");
}

function decodePixels(bytes: Buffer, isPng: boolean, filename: string): { width: number; height: number } {
  try {
    if (isPng) {
      checkPngStream(bytes);
      const img = PNG.sync.read(bytes, { checkCRC: true });
      if (img.data.length !== img.width * img.height * 4) throw new Error("incomplete pixel data");
      return { width: img.width, height: img.height };
    }
    checkJpegStream(bytes);
    const img = jpeg.decode(bytes, {
      useTArray: true,
      tolerantDecoding: false,
      maxResolutionInMP: (MAX_IMAGE_DIMENSION * MAX_IMAGE_DIMENSION) / 1e6,
      maxMemoryUsageInMB: 512,
    });
    return { width: img.width, height: img.height };
  } catch (err) {
    throw new ImageValidationError(`${filename}: image could not be decoded (${err instanceof Error ? err.message.slice(0, 120) : "corrupt data"})`);
  }
}

/** Validate one image and build its provenance. Throws ImageValidationError with a readable reason. */
export function acceptImage(input: ImageInput, now: Date = new Date()): AcceptedImage {
  const b64 = input.data_base64.replace(/\s+/g, "");
  if (!B64_RE.test(b64) || b64.length % 4 !== 0) throw new ImageValidationError(`${input.filename}: image data is not valid base64`);
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0) throw new ImageValidationError(`${input.filename}: image is empty`);
  if (bytes.length > MAX_IMAGE_BYTES) throw new ImageValidationError(`${input.filename}: image is ${bytes.length} bytes; the limit is ${MAX_IMAGE_BYTES}`);

  const isPng = bytes.subarray(0, 8).equals(PNG_SIG);
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!isPng && !isJpeg) throw new ImageValidationError(`${input.filename}: unsupported format (only JPEG and PNG are accepted)`);
  const actualMime = isPng ? "image/png" : "image/jpeg";
  if (actualMime !== input.mime_type) throw new ImageValidationError(`${input.filename}: declared ${input.mime_type} but the file content is ${actualMime}`);

  const size = isPng ? pngSize(bytes) : jpegSize(bytes);
  if (!size || size.width < 1 || size.height < 1) throw new ImageValidationError(`${input.filename}: image is corrupt or truncated`);
  if (size.width > MAX_IMAGE_DIMENSION || size.height > MAX_IMAGE_DIMENSION)
    throw new ImageValidationError(`${input.filename}: ${size.width}x${size.height} exceeds the ${MAX_IMAGE_DIMENSION}px limit`);

  // Header checks are not enough (a valid signature, IHDR/SOF and an end marker can wrap garbage):
  // fully decode the pixels, with CRC checks and strict entropy decoding. Bounded by the size checks above.
  const decoded = decodePixels(bytes, isPng, input.filename);
  if (decoded.width !== size.width || decoded.height !== size.height)
    throw new ImageValidationError(`${input.filename}: decoded size ${decoded.width}x${decoded.height} does not match the header`);

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    dataUrl: `data:${actualMime};base64,${b64}`,
    provenance: {
      image_id: input.image_id ?? `img-${randomUUID()}`,
      filename: input.filename,
      mime_type: actualMime,
      source_type: input.source_type,
      capture_timestamp: input.capture_timestamp ?? null, // never inferred
      uploaded_at: now.toISOString(),
      source_url: input.source_url ?? null,
      attribution: input.attribution ?? null,
      license: input.license ?? null,
      sha256,
      byte_size: bytes.length,
      width: size.width,
      height: size.height,
    },
  };
}

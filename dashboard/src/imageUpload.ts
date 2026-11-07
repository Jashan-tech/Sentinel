// Browser-side preparation of an inspection image (Feature 4).
// The agent service re-validates everything; this gives the operator fast, clear feedback
// and keeps oversized or corrupt files from ever being sent.
import { MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION, sniffImageType, type ImageAttachment, type ImageSourceType } from "./investigation";

const THUMB_MAX_SIDE = 320;
const THUMB_MAX_CHARS = 58_000; // SpacetimeDB accepts at most 60 000

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function thumbnail(bitmap: ImageBitmap): string {
  const scale = Math.min(1, THUMB_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  for (const q of [0.7, 0.55, 0.4, 0.25]) {
    const url = canvas.toDataURL("image/jpeg", q);
    if (url.length <= THUMB_MAX_CHARS) return url;
  }
  return ""; // preview is optional; provenance is still stored
}

export interface Provenance {
  sourceType: ImageSourceType;
  sourceUrl: string;
  attribution: string;
  license: string;
  /** datetime-local value, or "" when unknown. Never inferred from the file. */
  captureTime: string;
}

/** Validate a user-selected file and turn it into an attachment. Throws Error with a readable reason. */
export async function prepareImage(file: File, prov: Provenance): Promise<ImageAttachment> {
  if (file.size === 0) throw new Error("The file is empty.");
  if (file.size > MAX_IMAGE_BYTES) throw new Error(`The file is ${(file.size / 1048576).toFixed(1)} MB; the limit is 4 MB.`);
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(await file.arrayBuffer());
  const actual = sniffImageType(bytes);
  if (!actual) throw new Error("Unsupported file: only JPEG and PNG images are accepted.");
  if (file.type && file.type !== actual) throw new Error(`The file claims to be ${file.type} but its content is ${actual}.`);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: actual }));
  } catch {
    throw new Error("The image could not be decoded (corrupt or truncated file).");
  }
  try {
    if (bitmap.width > MAX_IMAGE_DIMENSION || bitmap.height > MAX_IMAGE_DIMENSION)
      throw new Error(`The image is ${bitmap.width}×${bitmap.height}; the limit is ${MAX_IMAGE_DIMENSION} px per side.`);
    if (prov.sourceUrl && !/^https?:\/\//.test(prov.sourceUrl)) throw new Error("Source URL must start with http:// or https://");
    return {
      imageId: `img-${crypto.randomUUID()}`,
      filename: file.name.slice(0, 200) || "image",
      mimeType: actual,
      base64: toBase64(bytes),
      sha256: await sha256Hex(bytes),
      byteSize: bytes.length,
      width: bitmap.width,
      height: bitmap.height,
      thumbnailDataUrl: thumbnail(bitmap),
      sourceType: prov.sourceType,
      captureTimestamp: prov.captureTime ? new Date(prov.captureTime).toISOString() : null,
      sourceUrl: prov.sourceUrl.trim(),
      attribution: prov.attribution.trim().slice(0, 300),
      license: prov.license.trim().slice(0, 100),
    };
  } finally {
    bitmap.close();
  }
}

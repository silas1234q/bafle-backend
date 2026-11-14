import { createHash } from "node:crypto";

import { env } from "../env.js";

/**
 * Cloudinary signed uploads.
 *
 * Image bytes never pass through this API. The browser asks for a signature,
 * uploads straight to Cloudinary, and posts back the resulting URL. That keeps
 * a 5MB photo off a free-tier dyno with no persistent disk and limited
 * bandwidth, and means an upload cannot occupy a request worker.
 *
 * The signature is what stops it being an open upload endpoint: it is computed
 * over fixed parameters, so a client cannot change the folder, the allowed
 * formats, or the size cap.
 */

export class CloudinaryNotConfiguredError extends Error {
  constructor() {
    super(
      "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, " +
        "CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.",
    );
    this.name = "CloudinaryNotConfiguredError";
  }
}

/** Everything the browser needs to upload directly. */
export interface UploadSignature {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
  uploadUrl: string;
  /** Echoed so the client sends exactly what was signed. */
  signedParams: Record<string, string | number>;
}

const UPLOAD_FOLDER = "bafle/products";

/**
 * Signs an upload.
 *
 * Cloudinary's scheme: sort the parameters by key, join as `k=v&k=v`, append
 * the API secret, and SHA-1 the result. Only the parameters included here are
 * covered, so anything the client adds unsigned is rejected by Cloudinary.
 */
export function createUploadSignature(userId: string): UploadSignature {
  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  const apiKey = env.CLOUDINARY_API_KEY;
  const apiSecret = env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new CloudinaryNotConfiguredError();
  }

  const timestamp = Math.floor(Date.now() / 1000);

  // Pinned into the signature so a client cannot widen any of them.
  const signedParams: Record<string, string | number> = {
    folder: UPLOAD_FOLDER,
    timestamp,
    // Attribution without trusting the client to report who uploaded.
    context: `uploader=${userId}`,
  };

  const toSign = Object.keys(signedParams)
    .sort()
    .map((key) => `${key}=${String(signedParams[key])}`)
    .join("&");

  const signature = createHash("sha1").update(`${toSign}${apiSecret}`).digest("hex");

  return {
    cloudName,
    apiKey,
    timestamp,
    signature,
    folder: UPLOAD_FOLDER,
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    signedParams,
  };
}

/**
 * Validates that a submitted image URL is genuinely one of ours.
 *
 * This is the important half. Without it, `ProductImage.url` accepts any
 * string, so a seller could point a listing at an arbitrary host: a tracking
 * pixel that deanonymises every viewer, an image that is swapped for something
 * illegal after moderation approves it, or simply someone else's bandwidth.
 *
 * Checks, in order: HTTPS, exact Cloudinary host, our cloud name as the first
 * path segment, our upload folder, and a known image extension.
 */
export function isOwnCloudinaryUrl(candidate: string): boolean {
  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  if (!cloudName) return false;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;
  // Exact host match, not endsWith: "res.cloudinary.com.evil.test" would pass
  // a suffix check.
  if (url.hostname !== "res.cloudinary.com") return false;
  if (url.search !== "" || url.hash !== "") return false;

  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments[0] !== cloudName) return false;

  // Cloudinary paths look like /<cloud>/image/upload/<transforms?>/<folder>/<id>.<ext>
  if (!url.pathname.includes(`/${UPLOAD_FOLDER}/`)) return false;

  const last = segments.at(-1) ?? "";
  return /\.(jpg|jpeg|png|webp|avif|gif)$/i.test(last);
}

/** Cloudinary is usable right now. */
export function cloudinaryConfigured(): boolean {
  return Boolean(
    env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET,
  );
}

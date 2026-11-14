import { Router } from "express";

import {
  CloudinaryNotConfiguredError,
  createUploadSignature,
} from "../images/cloudinary.js";
import { localUser, requireUser } from "../middleware/auth.js";
import { contentLimiter } from "../middleware/rateLimit.js";

export const uploadsRouter = Router();

uploadsRouter.use(requireUser);

/**
 * Hands the browser a short-lived signature so it can upload straight to
 * Cloudinary. Authenticated and rate limited, because each signature is
 * permission to put a file in our account.
 */
uploadsRouter.post("/signature", contentLimiter, (req, res) => {
  try {
    const signature = createUploadSignature(localUser(req).id);
    res.json(signature);
  } catch (error) {
    if (error instanceof CloudinaryNotConfiguredError) {
      res.status(503).json({ error: error.message });
      return;
    }
    throw error;
  }
});

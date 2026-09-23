import { Router } from "express";
import { createHash } from "node:crypto";
import { requireAuth } from "../lib/middleware";

const router = Router();

/**
 * @openapi
 * /cloudinary/signature:
 *   post:
 *     tags: [Cloudinary]
 *     summary: Get an upload signature for direct Cloudinary uploads
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Upload signature payload
 *       401: { description: Unauthorized }
 *       500: { description: Internal server error }
 */
router.post("/signature", requireAuth, async (_req, res) => {
  try {
    const cloudName = (process.env.CLOUDINARY_CLOUD_NAME ?? "").trim();
    const apiKey = (process.env.CLOUDINARY_API_KEY ?? "").trim();
    const apiSecret = (process.env.CLOUDINARY_API_SECRET ?? "").trim();
    const folder =
      (process.env.CLOUDINARY_FOLDER ?? "").trim() || "grahaura/infinity/v1";

    if (!cloudName || !apiKey || !apiSecret) {
      return res.status(500).json({ error: "Cloudinary is not configured" });
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const stringToSign = `folder=${folder}&timestamp=${timestamp}`;
    const signature = createHash("sha256")
      .update(`${stringToSign}${apiSecret}`)
      .digest("hex");

    return res.json({ folder, apiKey, signature, cloudName, timestamp });
  } catch (err) {
    console.error("Cloudinary signature error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

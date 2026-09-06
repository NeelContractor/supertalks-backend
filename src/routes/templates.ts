import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../lib/middleware";
import { db } from "../../prisma/db";
import { sendValidationError, paramString } from "../lib/http";

const router = Router();

interface TemplateFieldRecord {
  type: string;
  default?: unknown;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  itemName?: string;
  itemProps?: Record<string, TemplateFieldRecord>;
}

const templateFieldSchema: z.ZodType<TemplateFieldRecord> = z.lazy(() =>
  z.object({
    type: z.enum(["text", "textarea", "image", "select", "color", "number", "array"]),
    default: z.unknown().optional(),
    options: z.array(z.string()).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    itemName: z.string().optional(),
    itemProps: z.record(z.string(), templateFieldSchema).optional(),
  }),
);

const templateSectionSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1),
  default: z.boolean().default(true),
  props: z.record(z.string(), templateFieldSchema),
});

const createTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  previewImageUrl: z.string().url().optional().or(z.literal("")).or(z.null()),
  schema: z.object({
    design: z.record(z.string(), templateFieldSchema),
    sections: z.array(templateSectionSchema),
  }),
  isActive: z.boolean().optional(),
});

const updateTemplateSchema = createTemplateSchema.partial();

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, (err?: unknown) => {
    if (err) return;
    if (!req.user || req.user.role !== "Admin") {
      return res.status(403).json({ error: "Admin access required" });
    }
    next();
  });
}

/**
 * @openapi
 * /templates:
 *   get:
 *     tags: [Templates]
 *     summary: List available website templates
 *     responses:
 *       200: { description: List of templates }
 *       500: { description: Internal server error }
 */
router.get("/", async (req, res) => {
  try {
    const templates = await db.websiteTemplate.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "asc" },
    });
    return res.json({ templates });
  } catch (err) {
    console.error("List templates error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /templates/{id}:
 *   get:
 *     tags: [Templates]
 *     summary: Get a single template
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Template }
 *       404: { description: Template not found }
 *       500: { description: Internal server error }
 */
router.get("/:id", async (req, res) => {
  try {
    const id = paramString(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid template id" });

    const template = await db.websiteTemplate.findUnique({ where: { id } });
    if (!template) return res.status(404).json({ error: "Template not found" });
    return res.json({ template });
  } catch (err) {
    console.error("Get template error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /templates:
 *   post:
 *     tags: [Templates]
 *     summary: Create a website template (admin only)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, schema]
 *             properties:
 *               name: { type: string }
 *               previewImageUrl: { type: string, nullable: true }
 *               schema: { type: object }
 *               isActive: { type: boolean }
 *     responses:
 *       201: { description: Template created }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       403: { description: Admin access required }
 *       500: { description: Internal server error }
 */
router.post("/", requireAdmin, async (req, res) => {
  try {
    const parsed = createTemplateSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const { name, previewImageUrl, schema, isActive } = parsed.data;
    const template = await db.websiteTemplate.create({
      data: {
        name,
        previewImageUrl: previewImageUrl || null,
        schema: schema as never,
        isActive: isActive ?? true,
      },
    });
    return res.status(201).json({ template });
  } catch (err) {
    console.error("Create template error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /templates/{id}:
 *   patch:
 *     tags: [Templates]
 *     summary: Update a website template (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               previewImageUrl: { type: string, nullable: true }
 *               schema: { type: object }
 *               isActive: { type: boolean }
 *     responses:
 *       200: { description: Template updated }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       403: { description: Admin access required }
 *       404: { description: Template not found }
 *       500: { description: Internal server error }
 */
router.patch("/:id", requireAdmin, async (req, res) => {
  try {
    const parsed = updateTemplateSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const id = paramString(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid template id" });

    const existing = await db.websiteTemplate.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Template not found" });

    const data: Record<string, unknown> = { ...parsed.data };
    if (data.previewImageUrl === "" || data.previewImageUrl === null) {
      data.previewImageUrl = null;
    }

    const template = await db.websiteTemplate.update({ where: { id }, data: data as never });
    return res.json({ template });
  } catch (err) {
    console.error("Update template error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /templates/{id}:
 *   delete:
 *     tags: [Templates]
 *     summary: Delete a website template (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Template deleted }
 *       401: { description: Unauthorized }
 *       403: { description: Admin access required }
 *       404: { description: Template not found }
 *       500: { description: Internal server error }
 */
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const id = paramString(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid template id" });

    const existing = await db.websiteTemplate.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Template not found" });

    await db.websiteTemplate.delete({ where: { id } });
    return res.json({ message: "Template deleted" });
  } catch (err) {
    console.error("Delete template error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
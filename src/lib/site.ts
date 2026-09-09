import { db } from "../../prisma/db";
import type { Prisma } from "@prisma/client";

// =============================================================
// Website template schema + site document types
//
// A WebsiteTemplate.schema describes every value an astrologer is
// allowed to customise. Each field carries its own type + default so
// the editor can build controls generically and the renderer can
// re-theme the site at runtime.
//
//   schema.design    site-wide tokens (colors / fonts) -> CSS vars
//   schema.sections  ordered list of sections, each with typed props
//
// An astrologer's saved templateData is the FULL working document
// (design + sections), seeded from the template defaults on first
// edit. It is stored as:
//
//   { design: { key: value },
//     sections: { sectionId: { props: { key: value } } } }
//
// The renderable SiteDocument is the same content expanded into an
// ordered section array (id/type/name included).
// =============================================================

export type TemplateFieldType =
  | "text"
  | "textarea"
  | "image"
  | "select"
  | "color"
  | "number"
  | "array";

export interface TemplateField {
  type: TemplateFieldType;
  default?: unknown;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  itemName?: string;
  itemProps?: Record<string, TemplateField>;
}

export interface TemplateSection {
  id: string;
  type: string;
  name: string;
  default: boolean;
  props: Record<string, TemplateField>;
}

export interface TemplateSchema {
  design: Record<string, TemplateField>;
  sections: TemplateSection[];
}

export interface FieldStyle {
  fontSize?: string;
  color?: string;
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  textTransform?: string;
}

const FIELD_STYLE_KEYS = new Set([
  "fontSize",
  "color",
  "fontFamily",
  "fontWeight",
  "fontStyle",
  "textTransform",
]);

/** Keep only known string style keys so stored JSON stays predictable. */
export function sanitizeFieldStyle(value: unknown): FieldStyle | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: FieldStyle = {};
  for (const key of FIELD_STYLE_KEYS) {
    const v = value[key];
    if (typeof v === "string" && v !== "") out[key as keyof FieldStyle] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface StoredSection {
  props: Record<string, unknown>;
  fieldStyles?: Record<string, FieldStyle>;
}

export interface StoredTemplateData {
  design: Record<string, string | number>;
  sections: Record<string, StoredSection>;
}

export interface SiteSectionDoc {
  id: string;
  type: string;
  name: string;
  default: boolean;
  props: Record<string, unknown>;
  fieldStyles?: Record<string, FieldStyle>;
}

export interface SiteDocument {
  design: Record<string, string | number>;
  sections: SiteSectionDoc[];
}

const SCALAR_STRING_TYPES: TemplateFieldType[] = [
  "text",
  "textarea",
  "image",
  "select",
  "color",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural equality for arbitrary JSON-like values (Postgres jsonb reorders keys). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => deepEqual(a[key], b[key]));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((value, i) => deepEqual(value, b[i]));
  }
  return false;
}

function coerceScalar(field: TemplateField, value: unknown): string | number {
  if (field.type === "number") {
    if (typeof value === "number" && Number.isFinite(value)) {
      let v = value;
      if (typeof field.min === "number") v = Math.max(v, field.min);
      if (typeof field.max === "number") v = Math.min(v, field.max);
      return v;
    }
    return typeof field.default === "number" ? field.default : 1;
  }

  if (field.type === "select") {
    const options = field.options ?? [];
    if (typeof value === "string" && options.includes(value)) return value;
    return typeof field.default === "string" ? field.default : (options[0] ?? "");
  }

  if (SCALAR_STRING_TYPES.includes(field.type)) {
    return typeof value === "string" ? value : typeof field.default === "string" ? field.default : "";
  }

  return typeof field.default === "string" ? field.default : "";
}

function coerceArray(field: TemplateField, value: unknown): Record<string, unknown>[] {
  const itemProps = field.itemProps ?? {};

  const source = Array.isArray(value)
    ? value.filter(isPlainObject)
    : Array.isArray(field.default)
      ? field.default.filter(isPlainObject)
      : [];

  return source.map((item, itemIndex) => {
    const out: Record<string, unknown> = {};
    for (const [key, itemField] of Object.entries(itemProps)) {
      let value = item[key];
      // Backfill per-item selects added after a site was saved (e.g. the
      // approach icons) so existing sections still get varied defaults.
      if (
        value === undefined &&
        itemField.type === "select" &&
        itemField.options != null &&
        itemField.options.length > 0
      ) {
        value = itemField.options[itemIndex % itemField.options.length];
      }
      out[key] = coerceFieldValue(itemField, value);
    }
    return out;
  });
}

export function coerceFieldValue(field: TemplateField, value: unknown): unknown {
  if (field.type === "array") return coerceArray(field, value);
  return coerceScalar(field, value);
}

function resolveProps(
  fields: Record<string, TemplateField>,
  savedProps: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    out[key] = coerceFieldValue(field, savedProps?.[key]);
  }
  return out;
}

/** Sanitise incoming templateData into the stored shape, dropping anything the schema does not know about. */
// Sections that may never be removed from a live site. The stored data only
// tracks the sections an astrologer has, so dropping the key for a section
// removes it from their site.
export const ESSENTIAL_SECTION_IDS: ReadonlySet<string> = new Set(["book", "question"]);

export function sanitizeTemplateData(
  schema: TemplateSchema,
  input: unknown,
): StoredTemplateData {
  const raw = (isPlainObject(input) ? input : {}) as {
    design?: Record<string, unknown>;
    sections?: Record<
      string,
      { props?: Record<string, unknown>; fieldStyles?: Record<string, unknown> }
    >;
  };

  const design: Record<string, string | number> = {};
  for (const [key, field] of Object.entries(schema.design)) {
    const value = coerceFieldValue(field, raw.design?.[key]);
    design[key] =
      typeof value === "string" || typeof value === "number" ? value : String(value ?? "");
  }

  const rawSections = isPlainObject(raw.sections) ? raw.sections : null;
  const presentIds = rawSections ? new Set(Object.keys(rawSections)) : null;

  const sections: Record<string, StoredSection> = {};
  for (const section of schema.sections) {
    // No stored sections at all (new/legacy data) -> keep every schema section
    // with defaults. Otherwise keep submitted sections plus the essential ones,
    // so removing any other section actually persists.
    if (
      presentIds === null ||
      presentIds.has(section.id) ||
      ESSENTIAL_SECTION_IDS.has(section.id)
    ) {
      const stored = rawSections?.[section.id];
      const fieldStyles: Record<string, FieldStyle> = {};
      if (isPlainObject(stored?.fieldStyles)) {
        for (const [key, style] of Object.entries(stored.fieldStyles)) {
          const clean = sanitizeFieldStyle(style);
          if (clean) fieldStyles[key] = clean;
        }
      }
      sections[section.id] = {
        props: resolveProps(section.props, stored?.props),
        ...(Object.keys(fieldStyles).length > 0 ? { fieldStyles } : {}),
      };
    }
  }

  return { design, sections };
}

/** Build the renderable SiteDocument from a stored templateData, applying all defaults. */
export function mergeTemplate(schema: TemplateSchema, templateData: unknown): SiteDocument {
  const stored = sanitizeTemplateData(schema, templateData ?? {});
  return {
    design: stored.design,
    sections: schema.sections.flatMap((section) => {
      const storedSec = stored.sections[section.id];
      if (!storedSec) return [];
      return [
        {
          id: section.id,
          type: section.type,
          name: section.name,
          default: section.default,
          props: storedSec.props ?? {},
          ...(storedSec.fieldStyles ? { fieldStyles: storedSec.fieldStyles } : {}),
        },
      ];
    }),
  };
}

export function getTemplateSchema(template: { schema: unknown }): TemplateSchema {
  return template.schema as TemplateSchema;
}

// =============================================================
// Default template definition
// =============================================================

export const DEFAULT_TEMPLATE_SCHEMA: TemplateSchema = {
  design: {
    primaryColor: { type: "color", default: "#771609" },
    panelColor: { type: "color", default: "#fff4f3" },
    backgroundColor: { type: "color", default: "#fffcfc" },
    darkColor: { type: "color", default: "#253039" },
    displayFont: { type: "text", default: "serif" },
    bodyFont: { type: "text", default: "sans" },
  },
  sections: [
    {
      id: "hero",
      type: "HeroSection",
      name: "Hero",
      default: true,
      props: {
        siteName: { type: "text", default: "Astro Guide" },
        logo: { type: "image", default: "" },
        logoAlt: { type: "text", default: "Astro Guide" },
        heading: { type: "text", default: "Discover\nYour Path" },
        subtitle: { type: "text", default: "Guidance Through the Stars" },
        ctaLabel: { type: "text", default: "Book a Consultation" },
        ctaLink: { type: "text", default: "#book" },
        image: { type: "image", default: "/site-assets/portrait.jpg" },
        imageAlt: {
          type: "text",
          default: "Astrologer seated in a warm, plant-filled room",
        },
      },
    },
    {
      id: "words",
      type: "QuoteSection",
      name: "Words of Wisdom",
      default: true,
      props: {
        eyebrow: { type: "text", default: "Words of Wisdom" },
        quote: {
          type: "textarea",
          default:
            "The stars offer guidance, but your choices shape your journey. Through Vedic astrology, I help you understand the planetary influences in your life and find greater clarity, confidence, and direction.",
        },
      },
    },
    {
      id: "about",
      type: "AboutSection",
      name: "About",
      default: true,
      props: {
        heading: { type: "text", default: "About Your Astrologer" },
        body: {
          type: "textarea",
          default:
            "With a deep understanding of Vedic astrology, I offer personalized consultations to help you gain clarity about the important areas of your life. From career and relationships to marriage, finances, and personal growth, each reading is based on your unique birth chart. My approach combines traditional astrological wisdom with practical guidance, creating a thoughtful and meaningful experience for every consultation.",
        },
        buttonLabel: { type: "text", default: "Learn More" },
        buttonLink: { type: "text", default: "#about" },
      },
    },
    {
      id: "scene",
      type: "ImageBandSection",
      name: "Image Band",
      default: true,
      props: {
        image: { type: "image", default: "/site-assets/livingroom.jpg" },
        alt: { type: "text", default: "" },
      },
    },
    {
      id: "services",
      type: "ServicesSection",
      name: "Services",
      default: true,
      props: {
        heading: { type: "text", default: "Astrology Services" },
        items: {
          type: "array",
          itemName: "Service",
          itemProps: {
            title: { type: "text", default: "Birth Chart Reading" },
            body: {
              type: "textarea",
              default:
                "Understand your unique birth chart, planetary influences, strengths, challenges, and important life patterns through a personalized Vedic astrology reading.",
            },
          },
          default: [
            {
              title: "Birth Chart Reading",
              body: "Understand your unique birth chart, planetary influences, strengths, challenges, and important life patterns through a personalized Vedic astrology reading.",
            },
            {
              title: "Career & Finance",
              body: "Gain insights into your career path, professional opportunities, financial patterns, and favorable periods for making important decisions.",
            },
            {
              title: "Marriage & Relationships",
              body: "Explore relationship compatibility, marriage prospects, partnership patterns, and planetary influences affecting your personal relationships.",
            },
          ],
        },
      },
    },
    {
      id: "approach",
      type: "ApproachSection",
      name: "My Approach",
      default: true,
      props: {
        heading: { type: "text", default: "My Approach" },
        items: {
          type: "array",
          itemName: "Value",
          itemProps: {
            icon: {
              type: "select",
              options: ["leaf", "bloom", "teardrop"],
              default: "leaf",
            },
            title: { type: "text", default: "Value" },
            body: {
              type: "textarea",
              default: "Describe this value in a sentence.",
            },
          },
          default: [
            {
              icon: "leaf",
              title: "Traditional Wisdom",
              body: "I draw upon traditional Vedic astrology principles to interpret planetary positions, dashas, nakshatras, and transits within your birth chart.",
            },
            {
              icon: "bloom",
              title: "Personalized Guidance",
              body: "Every birth chart is unique. Each consultation is tailored to your individual circumstances, questions, goals, and planetary influences.",
            },
            {
              icon: "teardrop",
              title: "Clarity & Awareness",
              body: "Astrology is a tool for awareness and guidance. My goal is to help you understand your possibilities and approach life's important decisions with greater clarity.",
            },
          ],
        },
      },
    },
    {
      id: "book",
      type: "BookingSection",
      name: "Book a Session",
      default: true,
      props: {
        heading: { type: "text", default: "Book a Consultation" },
        subtitle: {
          type: "text",
          default: "Choose a convenient day and time for your personalized astrology consultation.",
        },
      },
    },
    {
      id: "question",
      type: "QuestionSection",
      name: "Ask a Question",
      default: true,
      props: {
        heading: { type: "text", default: "Ask an Astrologer" },
        subtitle: {
          type: "textarea",
          default:
            "Have a question about your birth chart, career, relationships, or life's next chapter? Send your question and receive personalized guidance.",
        },
        buttonLabel: { type: "text", default: "Ask a Question" },
      },
    },
    {
      id: "feedback",
      type: "FeedbackSection",
      name: "Client Feedback",
      default: true,
      props: {
        heading: { type: "text", default: "Client Feedback" },
        items: {
          type: "array",
          itemName: "Testimonial",
          itemProps: {
            quote: {
              type: "textarea",
              default: "Share a client testimonial here.",
            },
            author: { type: "text", default: "Happy Client" },
          },
          default: [
            {
              quote:
                "The consultation gave me a completely new perspective on my career and the decisions I was facing. The reading was detailed, thoughtful, and easy to understand.",
              author: "Sara H.",
            },
            {
              quote:
                "I was amazed by how clearly my birth chart reflected different phases of my life. The guidance helped me approach an important decision with much more confidence.",
              author: "James T.",
            },
            {
              quote:
                "A wonderful and insightful experience. Everything was explained patiently and in a practical way. I would definitely recommend a consultation.",
              author: "Emily L.",
            },
          ],
        },
      },
    },
    {
      id: "faq",
      type: "FaqSection",
      name: "FAQ",
      default: true,
      props: {
        heading: { type: "text", default: "Frequently Asked Questions" },
        items: {
          type: "array",
          itemName: "Question",
          itemProps: {
            question: { type: "text", default: "Question" },
            answer: {
              type: "textarea",
              default: "Answer the question here.",
            },
          },
          default: [
            {
              question: "What information do I need for a consultation?",
              answer:
                "Your date of birth, exact time of birth, and place of birth are generally required to prepare and interpret your birth chart accurately.",
            },
            {
              question: "What astrology services do you offer?",
              answer:
                "Consultations can cover birth chart readings, career and finance, marriage and relationships, compatibility, planetary periods, transits, and other areas of personal guidance.",
            },
            {
              question: "What can I expect during an astrology consultation?",
              answer:
                "During your consultation, we will explore your birth chart and discuss the areas of life that are most important to you. Planetary influences, significant periods, and relevant insights will be explained in a clear and practical way.",
            },
          ],
        },
      },
    },
    {
      id: "footer",
      type: "FooterSection",
      name: "Footer",
      default: true,
      props: {
        siteName: { type: "text", default: "Astro Guide" },
        logo: { type: "image", default: "" },
        logoAlt: { type: "text", default: "Astro Guide" },
        phone: { type: "text", default: "123-456-7890" },
        email: { type: "text", default: "info@astrology.com" },
        address: {
          type: "text",
          default: "500 Terry Francine St. San Francisco, CA 94158",
        },
        copyright: {
          type: "text",
          default: "© 2026 by Astro Guide. All rights reserved.",
        },
      },
    },
  ],
};

const DEFAULT_TEMPLATE = {
  name: "Supertalks",
  previewImageUrl: null,
  schema: DEFAULT_TEMPLATE_SCHEMA,
  isActive: true,
};

/** Idempotently ensure at least one base template exists (seeded on boot). */
export async function ensureDefaultTemplates() {
  const count = await db.websiteTemplate.count();
  if (count === 0) {
    await db.websiteTemplate.create({
      data: DEFAULT_TEMPLATE as unknown as Prisma.WebsiteTemplateCreateInput,
    });
    return;
  }

  // Keep the seeded default template's schema in sync with this file so
  // schema changes (new sections, new props, updated defaults) reach
  // existing astrologers' sites and the editor. Only the seeded default is
  // touched (identified by its seed values), never a customised template.
  const seed = await db.websiteTemplate.findFirst({
    where: { name: DEFAULT_TEMPLATE.name, isActive: true, previewImageUrl: null },
  });
  if (seed && !deepEqual(seed.schema, DEFAULT_TEMPLATE_SCHEMA)) {
    await db.websiteTemplate.update({
      where: { id: seed.id },
      data: { schema: DEFAULT_TEMPLATE_SCHEMA as unknown as Prisma.InputJsonValue },
    });
  }
}

/** The template a profile should use when none is chosen yet. */
export async function getDefaultRenderableTemplate() {
  const template = await db.websiteTemplate.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
  });
  if (template) return template;

  await ensureDefaultTemplates();
  return db.websiteTemplate.findFirst({ where: { isActive: true } });
}

export async function buildSite(profile: {
  templateId: string | null;
  templateData: unknown;
}) {
  const template = profile.templateId
    ? await db.websiteTemplate.findUnique({ where: { id: profile.templateId } })
    : await getDefaultRenderableTemplate();
  if (!template) throw new Error("No website template available");

  const schema = getTemplateSchema(template);
  const site = mergeTemplate(schema, profile.templateData);
  return { template, schema, site };
}
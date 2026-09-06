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

export interface StoredSection {
  props: Record<string, unknown>;
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

  return source.map((item) => {
    const out: Record<string, unknown> = {};
    for (const [key, itemField] of Object.entries(itemProps)) {
      out[key] = coerceFieldValue(itemField, item[key]);
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
export function sanitizeTemplateData(
  schema: TemplateSchema,
  input: unknown,
): StoredTemplateData {
  const raw = (isPlainObject(input) ? input : {}) as {
    design?: Record<string, unknown>;
    sections?: Record<string, { props?: Record<string, unknown> }>;
  };

  const design: Record<string, string | number> = {};
  for (const [key, field] of Object.entries(schema.design)) {
    const value = coerceFieldValue(field, raw.design?.[key]);
    design[key] =
      typeof value === "string" || typeof value === "number" ? value : String(value ?? "");
  }

  const sections: Record<string, StoredSection> = {};
  for (const section of schema.sections) {
    sections[section.id] = {
      props: resolveProps(section.props, raw.sections?.[section.id]?.props),
    };
  }

  return { design, sections };
}

/** Build the renderable SiteDocument from a stored templateData, applying all defaults. */
export function mergeTemplate(schema: TemplateSchema, templateData: unknown): SiteDocument {
  const stored = sanitizeTemplateData(schema, templateData ?? {});
  return {
    design: stored.design,
    sections: schema.sections.map((section) => ({
      id: section.id,
      type: section.type,
      name: section.name,
      default: section.default,
      props: stored.sections[section.id]?.props ?? {},
    })),
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
    displayFont: { type: "select", options: ["serif", "sans"], default: "serif" },
    bodyFont: { type: "select", options: ["sans", "serif"], default: "sans" },
  },
  sections: [
    {
      id: "hero",
      type: "HeroSection",
      name: "Hero",
      default: true,
      props: {
        siteName: { type: "text", default: "Lee Mor" },
        heading: { type: "text", default: "Discover\nInner Peace" },
        subtitle: { type: "text", default: "Embrace Healing Today" },
        ctaLabel: { type: "text", default: "Get Started" },
        ctaLink: { type: "text", default: "#words" },
        image: { type: "image", default: "/site-assets/portrait.jpg" },
        imageAlt: {
          type: "text",
          default: "Lee Mor seated in a warm, plant-filled room",
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
            "As a therapist, I believe in the power of healing through understanding and self-discovery. My goal is to support you on your journey towards mental well-being and inner peace.",
        },
      },
    },
    {
      id: "about",
      type: "AboutSection",
      name: "About",
      default: true,
      props: {
        heading: { type: "text", default: "About Lee Mor" },
        body: {
          type: "textarea",
          default:
            "Lee Mor is a dedicated therapist offering compassionate and personalized therapy services. With a focus on empathy and confidentiality, we provide a safe space for you to explore your feelings and work towards positive change. Our therapy sessions are tailored to your individual needs, promoting growth and self-awareness.",
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
        heading: { type: "text", default: "Services" },
        items: {
          type: "array",
          itemName: "Service",
          itemProps: {
            title: { type: "text", default: "Individual" },
            body: {
              type: "textarea",
              default:
                "Our individual therapy sessions are designed to address your specific concerns and help you navigate life's challenges. Through a collaborative and supportive approach, we aim to empower you to overcome obstacles and live a fulfilling life.",
            },
          },
          default: [
            {
              title: "Individual",
              body: "Our individual therapy sessions are designed to address your specific concerns and help you navigate life's challenges. Through a collaborative and supportive approach, we aim to empower you to overcome obstacles and live a fulfilling life.",
            },
            {
              title: "Couples",
              body: "Our couples therapy focuses on enhancing communication, building trust, and strengthening relationships. We provide a neutral and supportive environment for couples to address conflicts, improve intimacy, and foster a deeper connection.",
            },
            {
              title: "Family",
              body: "Family therapy sessions aim to improve family dynamics, resolve conflicts, and strengthen bonds. By promoting understanding and effective communication, we help families navigate challenges together and create harmonious relationships.",
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
            title: { type: "text", default: "Value" },
            body: {
              type: "textarea",
              default: "Describe this value in a sentence.",
            },
          },
          default: [
            {
              title: "Confidentiality",
              body: "Confidentiality is at the core of our therapy practice. We prioritize privacy and trust, ensuring that your personal information and sessions remain completely confidential.",
            },
            {
              title: "Empathy",
              body: "Empathy is the foundation of our therapeutic approach. We provide a compassionate and understanding environment where you can feel heard, validated, and supported throughout your healing journey.",
            },
            {
              title: "Personalized Care",
              body: "We believe in offering personalized care to every client. Our tailored therapy sessions focus on your unique needs and goals, allowing for a customized therapeutic experience.",
            },
          ],
        },
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
                "Lee Mor has been a guiding light in my journey towards self-discovery and healing. Their compassionate approach and expertise have truly",
              author: "Sara H.",
            },
            {
              quote:
                "I am grateful for Lee Mor's support and guidance during a challenging time in my life. Their professionalism and care have been invaluable.",
              author: "James T.",
            },
            {
              quote:
                "Lee Mor's therapy sessions have provided me with a safe space to explore my thoughts and emotions. I highly recommend their services",
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
              question: "What services do you offer?",
              answer:
                "Lee Mor provides a range of therapy services tailored to individual needs, including cognitive behavioral therapy, mindfulness techniques, and stress management. Each session is personalized to address specific concerns and promote overall well-being.",
            },
            {
              question: "How do I schedule an appointment?",
              answer:
                "Scheduling an appointment with Lee Mor is easy. Simply contact our office via phone or email to book a convenient time for your initial consultation. We strive to accommodate your schedule and provide prompt assistance.",
            },
            {
              question: "What can I expect during a therapy session?",
              answer:
                "During a therapy session with Lee Mor, you can expect a safe and confidential environment where you can openly discuss your thoughts and feelings. Our therapist will listen attentively, offer guidance, and work collaboratively with you to explore solutions and promote personal growth.",
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
        siteName: { type: "text", default: "Lee Mor" },
        phone: { type: "text", default: "123-456-7890" },
        email: { type: "text", default: "info@mysite.com" },
        address: {
          type: "text",
          default: "500 Terry Francine St. San Francisco, CA 94158",
        },
        copyright: {
          type: "text",
          default: "© 2035 by Lee Mor. Powered and secured by SuperTalks",
        },
      },
    },
  ],
};

const DEFAULT_TEMPLATE = {
  name: "Lee Mor – Therapist",
  previewImageUrl: null,
  schema: DEFAULT_TEMPLATE_SCHEMA,
  isActive: true,
};

/** Idempotently ensure at least one base template exists (seeded on boot). */
export async function ensureDefaultTemplates() {
  const count = await db.websiteTemplate.count();
  if (count > 0) return;
  await db.websiteTemplate.create({
    data: DEFAULT_TEMPLATE as unknown as Prisma.WebsiteTemplateCreateInput,
  });
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
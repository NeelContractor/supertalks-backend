import { Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";

/**
 * An astrologer's public identity is their profile slug: it is what
 * `/astrologers/:slug` and their published site are addressed by, so two
 * astrologers must never end up on the same one.
 *
 * `AstrologerProfile.slug` carries a unique index, which is the real guarantee.
 * This helper exists because a unique index on its own turns a collision into an
 * error the caller can only report as "internal server error" - the astrologer
 * would be told their signup failed for no visible reason and be stuck. Instead
 * we generate a wider random value and retry, so a collision is practically
 * invisible.
 */

/** 6 bytes = 12 hex chars = 48 bits of entropy (~2.8e14 combinations). */
export function randomAstrologerSlug(): string {
  return `astro-${randomBytes(6).toString("hex")}`;
}

/**
 * Prisma's unique-constraint violation. Detected structurally as well as via
 * `instanceof` so it keeps working across module instances and is testable
 * without provoking a real collision.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  ) {
    return true;
  }
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

/**
 * Which column a unique violation was about, e.g. `username` or `slug`.
 * Prisma reports it in `meta.target`, which is a string or an array of path
 * segments depending on the client version, so both shapes are handled.
 */
export function uniqueConstraintField(err: unknown): string | null {
  if (!isUniqueConstraintError(err)) return null;
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  const raw = Array.isArray(target) ? target.join(",") : target;
  if (typeof raw !== "string") return null;
  return (
    raw
      .split(",")
      .map((part) => part.trim())
      .find(Boolean) ?? null
  );
}

/**
 * Run `fn` with a fresh slug, retrying if that slug turns out to be taken.
 *
 * The retry deliberately re-runs the whole callback rather than just the insert:
 * a failed insert aborts the surrounding transaction, so the unit that has to be
 * repeated is whatever the caller wrapped (typically the signup transaction).
 */
export async function runWithUniqueSlug<T>(
  fn: (slug: string) => Promise<T>,
  options: { attempts?: number; generate?: () => string } = {}
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const generate = options.generate ?? randomAstrologerSlug;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn(generate());
    } catch (err) {
      // Only a slug collision is worth repeating. Anything else (missing user,
      // foreign key violation, connection loss) must surface to the caller.
      if (!isUniqueConstraintError(err) || uniqueConstraintField(err) !== "slug") {
        throw err;
      }
      lastError = err;
    }
  }

  throw lastError;
}
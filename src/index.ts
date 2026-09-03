console.log("Hello via Bun!");

// =============================================================
// ASTROLOGER-SIDE BACKEND — implemented endpoints
// =============================================================
//
// Auth
//   POST   /auth/register          (astrologer registers)
//   POST   /auth/signin            (login via email OR username)
//   POST   /auth/signout
//
// Astrologer own profile
//   GET    /astrologers/me
//   PATCH  /astrologers/me         (bio, specializations, languages, experienceYears, timezone)
//   PATCH  /astrologers/me/pricing
//   PATCH  /astrologers/me/template-data
//
// Public
//   GET    /astrologers/:slug      (public — for the rendered site)
//
// Availability
//   GET    /astrologers/me/availability-rules
//   POST   /astrologers/me/availability-rules
//   PATCH  /astrologers/me/availability-rules/:id
//   DELETE /astrologers/me/availability-rules/:id
//   GET    /astrologers/me/exceptions
//   POST   /astrologers/me/exceptions
//   DELETE /astrologers/me/exceptions/:id
//   GET    /astrologers/:slug/slots?date=2026-09-10    (public — computed open slots)
//
// TODO — not yet implemented
//   GET    /templates              (list available base templates for onboarding)
//   POST   /payments/orders
//   POST   /payments/webhook

// =============================================================
// CLIENT-SIDE TESTING HELPERS (dev only)
// Run on a separate port: bun run dev:testing  ->  src/testing.ts
// DELETE THIS before production.
//   POST   /testing/clients                       (register a test client)
//   GET    /testing/clients/:userId/token         (get client access token)
//   POST   /testing/questions                     (client asks a question)
//   POST   /testing/bookings                      (client creates a booking)
// =============================================================

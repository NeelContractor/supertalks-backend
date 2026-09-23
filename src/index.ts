console.log("Hello via Bun!");

// =============================================================
// ASTROLOGER-SIDE BACKEND — implemented endpoints
// =============================================================
//
// Auth
//   POST   /auth/register          (default role: Client)
//   POST   /auth/signin            (login via email OR username)
//   POST   /auth/signout
//
// Current user (any role)
//   GET    /me
//   PATCH  /me                     (name, mobile, profileImageUrl)
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
// Client-side actions (Client role only)
//   POST   /bookings               (+ Idempotency-Key header; slot-validated)
//   GET    /bookings               (own bookings; role-aware)
//   GET    /bookings/:id           (own bookings)
//   PATCH  /bookings/:id/reschedule
//   PATCH  /bookings/:id/cancel
//   POST   /questions
//   GET    /questions              (own questions; role-aware)
//   GET    /questions/:id          (own questions)
//
// TODO — not yet implemented
//   GET    /templates              (list available base templates for onboarding)
//
// Payments (provider-aware; "mock" needs no gateway, "phonepe" uses the
// PhonePe Payment Gateway Standard Checkout redirect flow)
//   POST   /payments/:paymentId/initiate    (returns a gateway redirectUrl)
//   GET    /payments/:paymentId             (poll the outcome after returning)
//   POST   /payments/webhook                (PhonePe callback — signed)
//   POST   /payments/phonepe/return         (PhonePe redirect target)
//   POST   /payments/:paymentId/complete    (mock settlement only)

// =============================================================
// CLIENT-SIDE TESTING HELPERS (dev only)
// Run on a separate port: bun run dev:testing  ->  src/testing.ts
// DELETE THIS before production.
//   POST   /testing/clients                       (register a test client)
//   GET    /testing/clients/:userId/token         (get client access token)
//   POST   /testing/questions                     (client asks a question)
//   POST   /testing/bookings                      (client creates a booking)
// =============================================================

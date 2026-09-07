# Backend

Astrologer-side backend for SuperTalks. Built with **Bun** + **Express 5** + **Prisma** (PostgreSQL). Request/response validation lives in the shared `@supertalks/contracts` zod schemas.

## Prerequisites

- [Bun](https://bun.com)
- A running PostgreSQL (see `docker-compose.yml`) with a `supertalks` database

## Setup

```bash
bun install          # install dependencies (incl. the linked @supertalks/contracts)
cp .env.example .env # configure DATABASE_URL + JWT secrets
bun prisma migrate deploy  # apply schema migrations
```

`.env` variables:

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/supertalks?schema=public
JWT_ACCESS_SECRET=...
JWT_REFRESH_SECRET=...
```

## Running

```bash
bun run dev          # start the API server on http://localhost:3000
```

Swagger docs: `http://localhost:3000/api-docs`

## Testing

Integration tests hit the real Postgres DB and clean up only their own records (unique emails per run), so they won't touch your existing data.

```bash
bun test             # run the test suite
```

### Client-side testing helpers (dev only)

Since this is an **astrologer-side** backend, client actions (register a client, ask a question, create a booking) are available through a separate test-only server. Run it alongside the main server:

```bash
bun run dev:testing  # starts on http://localhost:3100
```

> **Delete `src/testing.ts` before production.** See `src/index.ts` for the endpoint list.

## API Endpoints

### Auth

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/register` | Register (validated by `@supertalks/contracts`); creates a `Client` by default |
| `POST` | `/auth/signin` | Login via email **or** username |
| `POST` | `/auth/signout` | Revoke a refresh token (auth required) |

### Current user (auth required, any role)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/me` | Own profile |
| `PATCH` | `/me` | name, mobile, profileImageUrl |

### Client side (Client role only)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/bookings` | Book a slot (requires `Idempotency-Key` header; validated against open slots) |
| `GET` | `/bookings` | Own bookings (role-aware list + counts) |
| `GET` | `/bookings/:id` | Own booking detail |
| `PATCH` | `/bookings/:id/reschedule` | Reschedule own booking |
| `PATCH` | `/bookings/:id/cancel` | Cancel own booking |
| `POST` | `/questions` | Ask an astrologer a question |
| `GET` | `/questions` | Own questions (role-aware list + counts) |
| `GET` | `/questions/:id` | Own question detail |

Clients first fetch open slots at `GET /astrologers/:slug/slots?date=YYYY-MM-DD`, then create a booking
with the exact `startAt` value returned.

### Astrologer own profile (auth required)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/astrologers/me` | Own profile |
| `PATCH` | `/astrologers/me` | bio, specializations, languages, experienceYears, timezone |
| `PATCH` | `/astrologers/me/pricing` | question/call prices, slot duration, buffer |
| `PATCH` | `/astrologers/me/template-data` | website template id + data |

### Public

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/astrologers/:slug` | Public profile for the rendered site |
| `GET` | `/astrologers/:slug/slots?date=YYYY-MM-DD` | Computed open slots |

### Availability (auth required)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/astrologers/me/availability-rules` | List rules |
| `POST` | `/astrologers/me/availability-rules` | Create rule |
| `PATCH` | `/astrologers/me/availability-rules/:id` | Update rule |
| `DELETE` | `/astrologers/me/availability-rules/:id` | Delete rule |
| `GET` | `/astrologers/me/exceptions` | List exceptions |
| `POST` | `/astrologers/me/exceptions` | Create exception |
| `DELETE` | `/astrologers/me/exceptions/:id` | Delete exception |

Authenticated endpoints expect `Authorization: Bearer <accessToken>`.

## TODO — not yet implemented

- `GET /templates` — list available base templates for onboarding
- `POST /payments/orders` — create a provider order for a question/booking
- `POST /payments/webhook` — provider webhook (signature-verified, no auth)

## Postgres Commands

```bash
docker stop postgres                # stop
docker start postgres               # start again
docker logs postgres                # view logs
docker exec -it postgres psql -U postgres -d supertalks  # psql shell
```

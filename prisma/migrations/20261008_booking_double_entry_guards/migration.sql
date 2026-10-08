-- Double-booking guard.
--
-- No two slot-blocking bookings for the same astrologer may overlap in time.
-- btree_gist lets the uuid column participate in an EXCLUDE constraint, and
-- the partial predicate keeps PendingPayment soft holds plus cancelled /
-- completed rows out of the guard - it mirrors SLOT_BLOCKING in
-- src/routes/bookings.ts. This is the database-level backstop that closes the
-- check-then-act race between concurrent POST /bookings, reschedules and
-- payment settlements.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_no_overlap"
  EXCLUDE USING gist ("astrologer_id" WITH =, tsrange("start_at", "end_at") WITH &&)
  WHERE ("status" IN ('Confirmed', 'Rescheduled'));

-- Idempotency-Key support for POST /bookings: a retried request with the same
-- key from the same client resolves to the original booking instead of
-- creating a second one. NULL keys (legacy rows) never collide in Postgres.
ALTER TABLE "bookings" ADD COLUMN "idempotency_key" TEXT;

CREATE UNIQUE INDEX "bookings_client_id_idempotency_key_key"
  ON "bookings"("client_id", "idempotency_key");

-- The overlap checks query by (astrologer_id, start_at / end_at range).
CREATE INDEX "bookings_astrologer_id_start_at_idx" ON "bookings"("astrologer_id", "start_at");

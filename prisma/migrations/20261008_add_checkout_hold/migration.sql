-- Checkout holds.
--
-- A PendingPayment booking now reserves its slot for other clients while the
-- payer is on the payment page: hold_expires_at marks how long the hold lasts.
-- The slot frees up again the moment the payment fails, when it succeeds (the
-- booking becomes Confirmed), or when the hold expires without payment.
-- NULL means no hold (settled bookings, legacy rows, free bookings).
ALTER TABLE "bookings" ADD COLUMN "hold_expires_at" TIMESTAMP(3);

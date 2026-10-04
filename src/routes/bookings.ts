import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireCustomer } from "../lib/middleware";
import { db } from "../../prisma/db";
import { sendValidationError, paramString } from "../lib/http";
import {
  UserRole,
  BookingStatus,
  PaymentFor,
  PaymentStatus,
  Prisma,
} from "@prisma/client";
import {
  createBookingSchema,
  rescheduleBookingSchema,
  cancelBookingSchema,
} from "../types/scheduling";
import { openSlotsForRules } from "../lib/scheduling";
import { resolveService } from "../lib/site";

const router = Router();

const idempotencyKeyHeader = "Idempotency-Key";

const RESCHEDULABLE: BookingStatus[] = [
  BookingStatus.Confirmed,
  BookingStatus.Rescheduled,
];
const CANCELLABLE: BookingStatus[] = [
  BookingStatus.PendingPayment,
  BookingStatus.Confirmed,
  BookingStatus.Rescheduled,
];
// A slot is only reserved by a settled booking. PendingPayment bookings are
// soft holds: they let the same client resume an unfinished checkout without
// permanently blocking the slot if they abandon it.
const SLOT_BLOCKING: BookingStatus[] = [
  BookingStatus.Confirmed,
  BookingStatus.Rescheduled,
];

function inStatus(status: BookingStatus, list: BookingStatus[]): boolean {
  return list.includes(status);
}

function parseId(document: string | string[] | undefined) {
  const id = paramString(document);
  if (!id) return Promise.resolve(null);
  return db.booking.findUnique({ where: { id } });
}

/**
 * @openapi
 * /bookings:
 *   get:
 *     tags: [Bookings]
 *     summary: List my bookings (client or astrologer view)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         required: false
 *         schema:
 *           type: string
 *           enum: [PendingPayment, Confirmed, Rescheduled, Completed, CancelledByClient, CancelledByAstrologer, NoShowClient, NoShowAstrologer]
 *       - in: query
 *         name: role
 *         required: false
 *         schema:
 *           type: string
 *           enum: [client, astrologer]
 *       - in: query
 *         name: sort
 *         required: false
 *         description: Order by session start time. Defaults to latest.
 *         schema:
 *           type: string
 *           enum: [latest, oldest]
 *       - in: query
 *         name: upcoming
 *         required: false
 *         description: >
 *           Return only the soonest sessions that have not started yet
 *           (status Confirmed or Rescheduled, startAt in the future), ordered
 *           by nearest start first. Backs the dashboard navbar reminder. The
 *           `status` and `sort` params are ignored when this is set.
 *         schema:
 *           type: boolean
 *     responses:
 *       200: { description: List of bookings }
 *       400: { description: Invalid status filter }
 *       401: { description: Unauthorized }
 *       500: { description: Internal server error }
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const { status, role, sort, upcoming } = req.query;
    const userId = req.user!.id;

    const statusFilter =
      typeof status === "string" && status.length > 0 ? status : undefined;
    if (statusFilter && !(statusFilter in BookingStatus)) {
      return res.status(400).json({ error: "Invalid status filter" });
    }

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!user) return res.status(401).json({ error: "User not found" });

    const viewAs =
      role === "astrologer"
        ? UserRole.Astrologer
        : role === "client"
          ? UserRole.Client
          : user.role;

    let where: Record<string, unknown> = {};
    if (viewAs === UserRole.Astrologer) {
      const profile = await db.astrologerProfile.findUnique({
        where: { userId },
        select: { id: true },
      });
      if (!profile) return res.status(403).json({ error: "User is not an astrologer" });
      where.astrologerId = profile.id;
    } else {
      where.clientId = userId;
    }

    // `upcoming=true` is a schedule query, not a status-tab query: the
    // consumer wants "what is my next session", which is the *soonest* future
    // booking. `latest` sorts startAt descending (furthest first), so an
    // upcoming list has to force ascending order and drop the past.
    const now = new Date();
    const wantUpcoming = upcoming === "true" || upcoming === "1";
    // The Upcoming tab means "sessions still ahead of us". A Confirmed booking
    // whose start time has gone by has already run, so it drops out of this tab
    // (it stays in All, where it can still be completed or cancelled) instead of
    // lingering under a heading that says otherwise.
    const upcomingTab = statusFilter === BookingStatus.Confirmed;
    if (wantUpcoming) {
      where.status = { in: [...SLOT_BLOCKING] };
      where.startAt = { gt: now };
    } else if (statusFilter) {
      where.status = statusFilter;
      if (upcomingTab) where.startAt = { gt: now };
    } else if (viewAs === UserRole.Astrologer) {
      // An unpaid booking is only a slot hold on the checkout screen, and the
      // same thing the public slots endpoint already ignores. From the
      // provider's side it is not a session: it blocks nothing, earns nothing,
      // and an abandoned or failed checkout never reverts it (only the payment
      // is marked failed), so leaving it visible would accumulate phantom
      // bookings forever. The client still sees theirs - that hold is what they
      // have to pay or abandon. Same rule as unpaid questions in
      // routes/questions.ts.
      where.status = { not: BookingStatus.PendingPayment };
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    // Unknown/missing values fall back to `latest` so old clients keep working.
    const sortOrder = sort === "oldest" ? "asc" : "desc";
    // Nearest start first for `upcoming`; `id` breaks ties on equal startAt.
    const orderBy: Prisma.BookingOrderByWithRelationInput[] = wantUpcoming
      ? [{ startAt: "asc" }, { id: "asc" }]
      : [{ startAt: sortOrder }, { id: sortOrder }];

    // Base where scoped to the user (no status filter) for computing tab
    // counts. The tab counts describe the rows this caller can actually see, so
    // they repeat the astrologer default exclusion - otherwise "All (N)" would
    // keep counting the unpaid bookings that were just filtered out of the list.
    const hideUnpaid = viewAs === UserRole.Astrologer && !statusFilter && !wantUpcoming;
    const { status: _status, startAt: _startAt, ...scopedWhere } = where;
    const countWhere: Record<string, unknown> = hideUnpaid
      ? { ...scopedWhere, status: { not: BookingStatus.PendingPayment } }
      : scopedWhere;

    const [bookings, total, allTotal, confirmed, completed, cancelled, pending] = await Promise.all([
      db.booking.findMany({
        where,
        // Bookings are a schedule, so "latest" means the latest session start.
        // `id` is a stable tiebreaker for offset pagination on equal startAt.
        orderBy,
        take: limit,
        skip: offset,
include: {
            client: { select: { id: true, name: true, email: true } },
            astrologer: {
              select: {
                id: true,
                slug: true,
                user: { select: { name: true } },
              },
            },
          },
      }),
      db.booking.count({ where }),
      db.booking.count({ where: countWhere }),
      db.booking.count({
        where: {
          ...countWhere,
          status: { in: ["Confirmed", "Rescheduled"] as BookingStatus[] },
          // Same rule as the tab itself, so the badge can never promise more
          // sessions than the tab will list.
          startAt: { gt: now },
        },
      }),
      db.booking.count({ where: { ...countWhere, status: "Completed" } }),
      db.booking.count({
        where: {
          ...countWhere,
          status: {
            in: ["CancelledByClient", "CancelledByAstrologer"] as BookingStatus[],
          },
        },
      }),
      // No pending-payment tab exists for an astrologer (their default view has
      // no such rows), so the count is zero rather than a number they cannot
      // act on.
      hideUnpaid
        ? 0
        : db.booking.count({
            where: { ...countWhere, status: { in: ["PendingPayment"] as BookingStatus[] } },
          }),
    ]);

    return res.json({
      bookings,
      total,
      counts: {
        all: allTotal,
        Confirmed: confirmed,
        Completed: completed,
        Cancelled: cancelled,
        Pending: pending,
      },
    });
  } catch (err) {
    console.error("List bookings error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /bookings:
 *   post:
 *     tags: [Bookings]
 *     summary: Create a booking as a customer (any authenticated user, idempotency-keyed)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [astrologerId, startAt]
 *             properties:
 *               astrologerId: { type: string, format: uuid }
 *               startAt: { type: string, format: date-time, description: ISO 8601 UTC, pick from GET /astrologers/:slug/slots }
 *     responses:
 *       201: { description: Booking created }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       403: { description: Customer access required or astrologer not accepting bookings }
 *       404: { description: Astrologer not found }
 *       409: { description: Slot unavailable }
 *       500: { description: Internal server error }
 */
router.post("/", requireCustomer, async (req, res) => {
  try {
    const parsed = createBookingSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const idempotencyKey = req.headers[idempotencyKeyHeader.toLowerCase()];
    if (!idempotencyKey) {
      return res.status(400).json({ error: "Idempotency-Key header is required" });
    }

    const clientId = req.user!.id;
    const { astrologerId, startAt, serviceId, clientDetails } = parsed.data;

    const start = new Date(startAt);
    const dateKey = start.toISOString().slice(0, 10);

    const astrologer = await db.astrologerProfile.findUnique({
      where: { id: astrologerId },
      include: {
        availabilityRules: { where: { isActive: true } },
        availabilityExceptions: {
          where: { date: new Date(`${dateKey}T00:00:00`) },
        },
      },
    });
    if (!astrologer) return res.status(404).json({ error: "Astrologer not found" });

    if (!astrologer.isAcceptingBookings) {
      return res.status(403).json({ error: "Astrologer is not accepting bookings" });
    }

    const slotDuration = astrologer.slotDurationMinutes;
    const end = new Date(start.getTime() + slotDuration * 60000);

    const openSlots = openSlotsForRules(
      astrologer,
      astrologer.availabilityRules,
      astrologer.availabilityExceptions,
      dateKey
    );
    if (!openSlots.some((s) => s.startAt === start.toISOString())) {
      return res.status(409).json({ error: "Slot is not available for booking" });
    }

    // Resume an unfinished checkout for the same slot instead of stacking up
    // duplicate pending bookings (and so the client can retry the payment).
    const ownPending = await db.booking.findFirst({
      where: {
        astrologerId,
        clientId,
        status: BookingStatus.PendingPayment,
        startAt: { lt: end },
        endAt: { gt: start },
      },
      orderBy: { createdAt: "desc" },
    });
    if (ownPending) {
      const payment = ownPending.paymentId
        ? await db.payment.findUnique({
            where: { id: ownPending.paymentId },
            select: { id: true, amountPaise: true, currency: true, status: true },
          })
        : null;
      return res.status(200).json({ booking: ownPending, payment });
    }

    const overlapping = await db.booking.findFirst({
      where: {
        astrologerId,
        status: { in: SLOT_BLOCKING },
        startAt: { lt: end },
        endAt: { gt: start },
      },
    });
    if (overlapping) {
      return res.status(409).json({ error: "Slot is no longer available" });
    }

    // A service card only names the service; the price is read from the
    // astrologoger's own site document. Priced 0 (or no serviceId) falls back
    // to the profile's standard per-slot price. The booked length stays the
    // profile's slot duration so availability and buffers keep lining up.
    let pricePaise = astrologer.callPricePerSlotPaise;
    if (serviceId) {
      const service = await resolveService(astrologer, serviceId);
      if (!service) {
        return res.status(400).json({ error: "This service is no longer available" });
      }
      if (service.type !== "slot") {
        return res.status(400).json({ error: "This service is not a bookable session" });
      }
      if (service.pricePaise > 0) {
        pricePaise = service.pricePaise;
      }
    }
    const needsPayment = pricePaise > 0;

    const { booking, payment } = await db.$transaction(async (tx) => {
      let paymentId: string | null = null;
      let payment: {
        id: string;
        amountPaise: number;
        currency: string;
        status: PaymentStatus;
      } | null = null;

      if (needsPayment) {
        // One payment intent per slot; settling it confirms the booking.
        payment = await tx.payment.create({
          data: {
            payerId: clientId,
            payeeAstrologerId: astrologerId,
            amountPaise: pricePaise,
            currency: "INR",
            provider: "mock",
            purpose: PaymentFor.Booking,
            status: PaymentStatus.Created,
          },
          select: { id: true, amountPaise: true, currency: true, status: true },
        });
        paymentId = payment.id;
      }

      const booking = await tx.booking.create({
        data: {
          clientId,
          astrologerId,
          startAt: start,
          endAt: end,
          pricePaise,
          paymentId,
          status: needsPayment ? BookingStatus.PendingPayment : BookingStatus.Confirmed,
          ...(clientDetails
            ? { clientDetails: clientDetails as unknown as Prisma.InputJsonValue }
            : {}),
        },
      });

      return { booking, payment };
    });

    return res.status(201).json({ booking, payment });
  } catch (err) {
    console.error("Create booking error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /bookings/{id}:
 *   get:
 *     tags: [Bookings]
 *     summary: Get a booking by id (own bookings only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Booking }
 *       401: { description: Unauthorized }
 *       403: { description: Not allowed to view this booking }
 *       404: { description: Booking not found }
 *       500: { description: Internal server error }
 */
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const booking = await parseId(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const profile = await db.astrologerProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    const isOwner =
      booking.clientId === userId || (profile && booking.astrologerId === profile.id);

    if (!isOwner) {
      return res.status(403).json({ error: "Not allowed to view this booking" });
    }

    return res.json({ booking });
  } catch (err) {
    console.error("Get booking error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /bookings/{id}/reschedule:
 *   patch:
 *     tags: [Bookings]
 *     summary: Reschedule a booking
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
 *             required: [newStartAt]
 *             properties:
 *               newStartAt: { type: string, format: date-time, description: ISO 8601 UTC }
 *     responses:
 *       200: { description: Booking rescheduled }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       403: { description: Not allowed or invalid booking state }
 *       404: { description: Booking not found }
 *       409: { description: Slot unavailable }
 *       500: { description: Internal server error }
 */
router.patch("/:id/reschedule", requireAuth, async (req, res) => {
  try {
    const parsed = rescheduleBookingSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const userId = req.user!.id;
    const booking = await parseId(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const isClient = booking.clientId === userId;
    const profile = await db.astrologerProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    const isAstrologer = profile && booking.astrologerId === profile.id;

    if (!isClient && !isAstrologer) {
      return res.status(403).json({ error: "Not allowed to reschedule this booking" });
    }

    if (!inStatus(booking.status, RESCHEDULABLE)) {
      return res.status(403).json({ error: "Booking is not reschedulable" });
    }

    const newStart = new Date(parsed.data.newStartAt);
    const newEnd = new Date(newStart.getTime() + booking.endAt.getTime() - booking.startAt.getTime());

    const overlapping = await db.booking.findFirst({
      where: {
        astrologerId: booking.astrologerId,
        id: { not: booking.id },
        status: { in: SLOT_BLOCKING },
        startAt: { lt: newEnd },
        endAt: { gt: newStart },
      },
    });
    if (overlapping) {
      return res.status(409).json({ error: "Slot is no longer available" });
    }

    const updated = await db.booking.update({
      where: { id: booking.id },
      data: {
        startAt: newStart,
        endAt: newEnd,
        status: BookingStatus.Rescheduled,
      },
    });

    return res.json({ booking: updated });
  } catch (err) {
    console.error("Reschedule booking error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /bookings/{id}/cancel:
 *   patch:
 *     tags: [Bookings]
 *     summary: Cancel a booking (client or astrologer)
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
 *               reason: { type: string, nullable: true, maxLength: 300 }
 *     responses:
 *       200: { description: Booking cancelled }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       403: { description: Not allowed or invalid booking state }
 *       404: { description: Booking not found }
 *       500: { description: Internal server error }
 */
router.patch("/:id/cancel", requireAuth, async (req, res) => {
  try {
    const parsed = cancelBookingSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const userId = req.user!.id;
    const booking = await parseId(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const isClient = booking.clientId === userId;
    const profile = await db.astrologerProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    const isAstrologer = profile && booking.astrologerId === profile.id;

    if (!isClient && !isAstrologer) {
      return res.status(403).json({ error: "Not allowed to cancel this booking" });
    }

    if (!inStatus(booking.status, CANCELLABLE)) {
      return res.status(403).json({ error: "Booking is not cancellable" });
    }

    const newStatus = isClient
      ? BookingStatus.CancelledByClient
      : BookingStatus.CancelledByAstrologer;

    const updated = await db.booking.update({
      where: { id: booking.id },
      data: {
        status: newStatus,
        cancelledBy: userId,
        cancellationReason: parsed.data.reason,
      },
    });

    return res.json({ booking: updated });
  } catch (err) {
    console.error("Cancel booking error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /bookings/{id}/complete:
 *   patch:
 *     tags: [Bookings]
 *     summary: Mark a booking complete (astrologer only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Booking marked complete }
 *       401: { description: Unauthorized }
 *       403: { description: Not an astrologer or invalid booking state }
 *       404: { description: Booking not found }
 *       500: { description: Internal server error }
 */
router.patch("/:id/complete", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const booking = await parseId(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const profile = await db.astrologerProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!profile || booking.astrologerId !== profile.id) {
      return res.status(403).json({ error: "Only the assigned astrologer can complete a booking" });
    }

    if (!inStatus(booking.status, RESCHEDULABLE)) {
      return res.status(403).json({ error: "Booking is not in a completable state" });
    }

    const updated = await db.booking.update({
      where: { id: booking.id },
      data: { status: BookingStatus.Completed },
    });

    return res.json({ booking: updated });
  } catch (err) {
    console.error("Complete booking error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

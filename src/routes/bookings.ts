import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../lib/middleware";
import { db } from "../../prisma/db";
import { sendValidationError, paramString } from "../lib/http";
import {
  UserRole,
  BookingStatus,
} from "@prisma/client";
import {
  createBookingSchema,
  rescheduleBookingSchema,
  cancelBookingSchema,
} from "../types/scheduling";

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
const ACTIVE: BookingStatus[] = [
  BookingStatus.PendingPayment,
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
 *     responses:
 *       200: { description: List of bookings }
 *       400: { description: Invalid status filter }
 *       401: { description: Unauthorized }
 *       500: { description: Internal server error }
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const { status, role } = req.query;
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

    if (statusFilter) where.status = statusFilter;

    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    // Base where scoped to the user (no status filter) for computing tab counts
    const { status: _status, ...countWhere } = where;

    const [bookings, total, allTotal, confirmed, completed, cancelled, pending] = await Promise.all([
      db.booking.findMany({
        where,
        orderBy: { startAt: "desc" },
        take: limit,
        skip: offset,
        include: {
          client: { select: { id: true, name: true, email: true } },
          astrologer: {
            select: {
              id: true,
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
      db.booking.count({
        where: {
          ...countWhere,
          status: { in: ["PendingPayment"] as BookingStatus[] },
        },
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
 *     summary: Create a booking as a client (idempotency-keyed)
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
 *               startAt: { type: string, format: date-time, description: ISO 8601 UTC }
 *     responses:
 *       201: { description: Booking created }
 *       400: { description: Validation error }
 *       401: { description: Unauthorized }
 *       404: { description: Astrologer not found }
 *       409: { description: Slot unavailable }
 *       500: { description: Internal server error }
 */
router.post("/", requireAuth, async (req, res) => {
  try {
    const parsed = createBookingSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const idempotencyKey = req.headers[idempotencyKeyHeader.toLowerCase()];
    if (!idempotencyKey) {
      return res.status(400).json({ error: "Idempotency-Key header is required" });
    }

    const clientId = req.user!.id;
    const { astrologerId, startAt } = parsed.data;

    const astrologer = await db.astrologerProfile.findUnique({
      where: { id: astrologerId },
    });
    if (!astrologer) return res.status(404).json({ error: "Astrologer not found" });

    const slotDuration = astrologer.slotDurationMinutes;
    const start = new Date(startAt);
    const end = new Date(start.getTime() + slotDuration * 60000);

    const overlapping = await db.booking.findFirst({
      where: {
        astrologerId,
        status: { in: ACTIVE },
        startAt: { lt: end },
        endAt: { gt: start },
      },
    });
    if (overlapping) {
      return res.status(409).json({ error: "Slot is no longer available" });
    }

    const booking = await db.booking.create({
      data: {
        clientId,
        astrologerId,
        startAt: start,
        endAt: end,
        pricePaise: astrologer.callPricePerSlotPaise,
        status: BookingStatus.PendingPayment,
      },
    });

    return res.status(201).json({ booking });
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
        status: { in: ACTIVE },
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

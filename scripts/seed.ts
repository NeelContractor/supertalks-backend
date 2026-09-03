/**
 * Seed bookings & questions for an existing astrologer.
 *
 * Usage:
 *   bun run scripts/seed.ts <astrologer-username> [options]
 *
 * Options:
 *   --clients <n>   Number of fake clients to create (default: 5)
 *   --bookings <n>  Bookings per client (default: 2)
 *   --questions <n> Questions per client (default: 2)
 *   --clear         Delete all seeded data for this astrologer first
 */

import { db } from "../prisma/db";
import { hashPassword } from "../src/lib/auth";
import {
  BookingStatus,
  QuestionStatus,
  PaymentStatus,
  PaymentFor,
  UserRole,
} from "@prisma/client";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0].startsWith("--")) {
    console.error("Usage: bun run scripts/seed.ts <astrologer-username> [options]");
    process.exit(1);
  }

  const username = args[0].toLowerCase();
  const opts: { clients: number; bookings: number; questions: number; clear: boolean } = {
    clients: 5,
    bookings: 2,
    questions: 2,
    clear: false,
  };

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--clients":
        opts.clients = Number(args[++i]);
        break;
      case "--bookings":
        opts.bookings = Number(args[++i]);
        break;
      case "--questions":
        opts.questions = Number(args[++i]);
        break;
      case "--clear":
        opts.clear = true;
        break;
    }
  }

  return { username, opts };
}

// ---------------------------------------------------------------------------
// Fake data generators
// ---------------------------------------------------------------------------

const FIRST_NAMES = [
  "Aarav", "Vivaan", "Aditya", "Arjun", "Sai",
  "Priya", "Ananya", "Diya", "Kavya", "Meera",
  "Rohan", "Kiran", "Nisha", "Pooja", "Rahul",
  "Sneha", "Vikram", "Tanvi", "Amit", "Deepa",
  "Neha", "Suresh", "Lakshmi", "Gaurav", "Isha",
  "Manoj", "Sunita", "Tarun", "Pallavi", "Sanjay",
];

const LAST_NAMES = [
  "Sharma", "Patel", "Kumar", "Singh", "Reddy",
  "Gupta", "Nair", "Joshi", "Desai", "Iyer",
  "Mehta", "Rao", "Verma", "Chopra", "Malhotra",
  "Bhat", "Pandey", "Mishra", "Tiwari", "Kapoor",
];

const QUESTIONS: { text: string; category: string }[] = [
  { text: "When will I get promoted at work? I have been waiting for a long time.", category: "Career" },
  { text: "Is this the right time to invest in property or should I wait?", category: "Finance" },
  { text: "My partner and I are having conflicts. Will things improve soon?", category: "Relationship" },
  { text: "What does my birth chart say about my health in the coming months?", category: "Health" },
  { text: "I have been facing obstacles in my business. When will things turn around?", category: "Career" },
  { text: "Will I be able to settle abroad in the next two years?", category: "Life" },
  { text: "My child is not performing well in studies. What remedies do you suggest?", category: "Education" },
  { text: "I am planning a major financial decision. Is the timing auspicious?", category: "Finance" },
  { text: "When will I meet my life partner according to my horoscope?", category: "Relationship" },
  { text: "I keep getting rejected in job interviews. What does my chart indicate?", category: "Career" },
  { text: "Should I change my career path or stay in my current role?", category: "Career" },
  { text: "There are legal disputes in my family. When will they get resolved?", category: "Life" },
  { text: "I have been experiencing health issues recently. Is there something astrological behind it?", category: "Health" },
  { text: "When is the best time to start a new venture according to my chart?", category: "Business" },
  { text: "My married life has been stressful. What do the stars say about it?", category: "Relationship" },
  { text: "Will I inherit property from my family?", category: "Finance" },
  { text: "I am planning to travel abroad. Is it a good time according to my horoscope?", category: "Travel" },
  { text: "When will I be able to buy my own house?", category: "Property" },
  { text: "I am confused between two career options. Which one is better for me?", category: "Career" },
  { text: "What remedies should I follow to improve my financial situation?", category: "Finance" },
];

const CLIENT_NOTES = [
  "Looking forward to the session.",
  "Please be available 5 minutes before the scheduled time.",
  "I have some specific questions about my career.",
  "This is my first consultation, feeling a bit nervous.",
  "I was referred by a friend. Hope this helps.",
  "I need guidance on a major life decision.",
  null,
  null,
  null,
  null,
];

const CANCEL_REASONS = [
  "Schedule conflict, need to reschedule.",
  "Personal emergency came up.",
  "Found a better time slot.",
  "No longer needed.",
];

const REJECTION_REASONS = [
  "This question is outside the scope of astrology consultation.",
  "Please rephrase your question with more specific details.",
  "This question requires more context about your birth chart.",
];

const ANSWERS = [
  "Based on your birth chart, the current planetary positions suggest a favorable period ahead. Saturn's transit through your 10th house indicates career growth, but patience is required. I recommend performing the Shani mantra regularly.",
  "Your horoscope shows strong indications of financial improvement after the next quarter. Jupiter's aspect on your 2nd house is positive. Avoid making hasty decisions until Mercury retrograde ends.",
  "The alignment of Venus and Mars in your 7th house suggests relationship dynamics are shifting. Communication will be key. I suggest wearing a diamond or white sapphire after consulting with me.",
  "Your chart shows some health concerns related to the 6th house. Regular exercise, meditation, and the prescribed remedies will help. Avoid travel during Rahu kaal.",
  "Rahu's placement in your ascendant is causing confusion and delays. The recommended Puja and gemstone (Hessonite) will help neutralize the negative effects. Results should be visible within 3-4 months.",
  "The Dasha period you are currently running is challenging but temporary. Focus on the positive houses in your chart. Jupiter's transit next month will bring relief.",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
}

function randomId(): string {
  return crypto.randomUUID();
}

function daysFromNow(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

function hoursFromNow(hours: number): Date {
  const d = new Date();
  d.setHours(d.getHours() + hours);
  return d;
}

// ---------------------------------------------------------------------------
// Seed logic
// ---------------------------------------------------------------------------

async function clearData(astrologerProfileId: string) {
  console.log("Clearing existing seeded data...");

  // Delete payments linked to bookings/questions for this astrologer
  const bookings = await db.booking.findMany({
    where: { astrologerId: astrologerProfileId },
    select: { paymentId: true },
  });
  const questions = await db.question.findMany({
    where: { astrologerId: astrologerProfileId },
    select: { paymentId: true },
  });

  const paymentIds = [
    ...bookings.map((b) => b.paymentId).filter(Boolean),
    ...questions.map((q) => q.paymentId).filter(Boolean),
  ] as string[];

  if (paymentIds.length > 0) {
    await db.payment.deleteMany({ where: { id: { in: [...new Set(paymentIds)] } } });
  }

  await db.booking.deleteMany({ where: { astrologerId: astrologerProfileId } });
  await db.question.deleteMany({ where: { astrologerId: astrologerProfileId } });

  console.log("  Cleared all bookings and questions for this astrologer.");
}

async function createClient(index: number) {
  const firstName = pick(FIRST_NAMES);
  const lastName = pick(LAST_NAMES);
  const name = `${firstName} ${lastName}`;
  const email = `testclient_${firstName.toLowerCase()}${lastName.toLowerCase()}_${index}@example.com`;
  const username = `client_${firstName.toLowerCase()}${lastName.toLowerCase()}_${index}`.slice(0, 30);
  const passwordHash = await hashPassword("TestPassword123!");

  const user = await db.user.create({
    data: {
      name,
      email,
      username,
      passwordHash,
      role: UserRole.Client,
    },
  });

  return user;
}

function createBookingData(
  clientId: string,
  astrologerProfileId: string,
  callPrice: number,
  slotMinutes: number,
  status: BookingStatus,
  startAt: Date,
) {
  const endAt = new Date(startAt.getTime() + slotMinutes * 60000);
  const data: Record<string, unknown> = {
    clientId,
    astrologerId: astrologerProfileId,
    startAt,
    endAt,
    pricePaise: callPrice,
    status,
    clientNote: pick(CLIENT_NOTES),
  };

  if (
    status === BookingStatus.CancelledByClient ||
    status === BookingStatus.CancelledByAstrologer
  ) {
    data.cancelledBy = clientId;
    data.cancellationReason = pick(CANCEL_REASONS);
  }

  if (status === BookingStatus.NoShowClient || status === BookingStatus.NoShowAstrologer) {
    data.meetingLink = `https://meet.supertalks.in/${randomId().slice(0, 8)}`;
  }

  if (status === BookingStatus.Completed || status === BookingStatus.Confirmed) {
    data.meetingLink = `https://meet.supertalks.in/${randomId().slice(0, 8)}`;
  }

  return data;
}

function createQuestionData(
  clientId: string,
  astrologerProfileId: string,
  questionPrice: number,
  status: QuestionStatus,
) {
  const q = pick(QUESTIONS);
  const data: Record<string, unknown> = {
    clientId,
    astrologerId: astrologerProfileId,
    questionText: q.text,
    category: q.category,
    pricePaise: questionPrice,
    status,
  };

  if (status === QuestionStatus.Answered) {
    data.answerText = pick(ANSWERS);
    data.answeredAt = daysFromNow(-Math.floor(Math.random() * 10 + 1));
  }

  if (status === QuestionStatus.Rejected) {
    data.rejectionReason = pick(REJECTION_REASONS);
  }

  return data;
}

async function seed() {
  const { username, opts } = parseArgs();

  console.log(`\nSeeding data for astrologer: @${username}`);
  console.log(`  Clients: ${opts.clients}, Bookings/client: ${opts.bookings}, Questions/client: ${opts.questions}\n`);

  // Find the astrologer
  const user = await db.user.findUnique({
    where: { username },
    select: { id: true, name: true, astrologerProfile: true },
  });

  if (!user) {
    console.error(`Error: User @${username} not found.`);
    process.exit(1);
  }

  if (!user.astrologerProfile) {
    console.error(`Error: @${username} does not have an astrologer profile.`);
    process.exit(1);
  }

  const profile = user.astrologerProfile;

  if (opts.clear) {
    await clearData(profile.id);
  }

  // Booking statuses to cycle through for variety
  const bookingStatuses: BookingStatus[] = [
    BookingStatus.PendingPayment,
    BookingStatus.Confirmed,
    BookingStatus.Completed,
    BookingStatus.CancelledByClient,
    BookingStatus.CancelledByAstrologer,
    BookingStatus.NoShowClient,
    BookingStatus.Rescheduled,
  ];

  const questionStatuses: QuestionStatus[] = [
    QuestionStatus.PendingPayment,
    QuestionStatus.Queued,
    QuestionStatus.Answered,
    QuestionStatus.Rejected,
  ];

  let totalBookings = 0;
  let totalQuestions = 0;
  const createdClientIds: string[] = [];

  for (let i = 0; i < opts.clients; i++) {
    const client = await createClient(i);
    createdClientIds.push(client.id);
    console.log(`  Created client: ${client.name} (@${client.username})`);

    // Create bookings
    for (let j = 0; j < opts.bookings; j++) {
      const status = bookingStatuses[(i * opts.bookings + j) % bookingStatuses.length];
      let startAt: Date;

      // Vary dates: past completed, today's confirmed, future pending
      if (status === BookingStatus.Completed) {
        startAt = daysFromNow(-Math.floor(Math.random() * 30 + 1));
      } else if (status === BookingStatus.Confirmed) {
        startAt = hoursFromNow(Math.floor(Math.random() * 48 + 1));
      } else if (
        status === BookingStatus.CancelledByClient ||
        status === BookingStatus.CancelledByAstrologer ||
        status === BookingStatus.NoShowClient ||
        status === BookingStatus.NoShowAstrologer
      ) {
        startAt = daysFromNow(-Math.floor(Math.random() * 15 + 1));
      } else {
        startAt = daysFromNow(Math.floor(Math.random() * 14 + 1));
      }

      // Round to nearest 30 min
      startAt.setMinutes(Math.round(startAt.getMinutes() / 30) * 30, 0, 0);

      const bookingData = createBookingData(
        client.id,
        profile.id,
        profile.callPricePerSlotPaise,
        profile.slotDurationMinutes,
        status,
        startAt,
      );

      await db.booking.create({ data: bookingData as any });
      totalBookings++;
    }

    // Create questions
    for (let j = 0; j < opts.questions; j++) {
      const status = questionStatuses[(i * opts.questions + j) % questionStatuses.length];

      const questionData = createQuestionData(
        client.id,
        profile.id,
        profile.questionPricePaise,
        status,
      );

      await db.question.create({ data: questionData as any });
      totalQuestions++;
    }
  }

  // Create some payments for completed/confirmed bookings and answered questions
  const completedBookings = await db.booking.findMany({
    where: {
      astrologerId: profile.id,
      status: { in: [BookingStatus.Completed, BookingStatus.Confirmed] },
      paymentId: null,
    },
  });

  for (const booking of completedBookings) {
    const payment = await db.payment.create({
      data: {
        payerId: booking.clientId,
        payeeAstrologerId: profile.id,
        amountPaise: booking.pricePaise,
        provider: "razorpay",
        providerPaymentId: `pay_test_${randomId().slice(0, 8)}`,
        status: PaymentStatus.Succeeded,
        purpose: PaymentFor.Booking,
      },
    });
    await db.booking.update({
      where: { id: booking.id },
      data: { paymentId: payment.id },
    });
  }

  const answeredQuestions = await db.question.findMany({
    where: {
      astrologerId: profile.id,
      status: { in: [QuestionStatus.Answered] },
      paymentId: null,
    },
  });

  for (const question of answeredQuestions) {
    const payment = await db.payment.create({
      data: {
        payerId: question.clientId,
        payeeAstrologerId: profile.id,
        amountPaise: question.pricePaise,
        provider: "razorpay",
        providerPaymentId: `pay_test_${randomId().slice(0, 8)}`,
        status: PaymentStatus.Succeeded,
        purpose: PaymentFor.Question,
      },
    });
    await db.question.update({
      where: { id: question.id },
      data: { paymentId: payment.id },
    });
  }

  console.log(`\nDone! Summary:`);
  console.log(`  Astrologer: ${user.name} (@${username})`);
  console.log(`  Clients created: ${opts.clients}`);
  console.log(`  Bookings created: ${totalBookings}`);
  console.log(`  Questions created: ${totalQuestions}`);
  console.log(`  Payments created: ${completedBookings.length + answeredQuestions.length}\n`);

  await db.$disconnect();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});

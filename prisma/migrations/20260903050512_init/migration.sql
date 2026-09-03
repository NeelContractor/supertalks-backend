-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('Client', 'Astrologer', 'Admin');

-- CreateEnum
CREATE TYPE "astrologer_status" AS ENUM ('Pending', 'Approved', 'Rejected', 'Suspended');

-- CreateEnum
CREATE TYPE "question_status" AS ENUM ('PendingPayment', 'Queued', 'Answered', 'Rejected', 'Refunded');

-- CreateEnum
CREATE TYPE "booking_status" AS ENUM ('PendingPayment', 'Confirmed', 'Rescheduled', 'Completed', 'CancelledByClient', 'CancelledByAstrologer', 'NoShowClient', 'NoShowAstrologer');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('Created', 'Succeeded', 'Failed', 'Refunded', 'PartiallyRefunded');

-- CreateEnum
CREATE TYPE "payment_for" AS ENUM ('Question', 'Booking');

-- CreateEnum
CREATE TYPE "oauth_provider" AS ENUM ('Google');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "mobile" TEXT,
    "mobile_verified" BOOLEAN NOT NULL DEFAULT false,
    "username" TEXT NOT NULL,
    "password_hash" TEXT,
    "profile_image_url" TEXT,
    "role" "user_role" NOT NULL DEFAULT 'Client',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "oauth_provider" NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_templates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "preview_image_url" TEXT,
    "schema" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "website_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "astrologer_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "astrologer_status" NOT NULL DEFAULT 'Pending',
    "bio" TEXT,
    "specializations" TEXT[],
    "languages" TEXT[],
    "experience_years" INTEGER,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "question_price_paise" INTEGER NOT NULL DEFAULT 0,
    "call_price_per_slot_paise" INTEGER NOT NULL DEFAULT 0,
    "slot_duration_minutes" INTEGER NOT NULL DEFAULT 30,
    "buffer_minutes" INTEGER NOT NULL DEFAULT 5,
    "cancellation_window_hours" INTEGER NOT NULL DEFAULT 6,
    "rating_avg_x100" INTEGER NOT NULL DEFAULT 0,
    "rating_count" INTEGER NOT NULL DEFAULT 0,
    "template_id" UUID,
    "template_data" JSONB NOT NULL DEFAULT '{}',
    "is_accepting_questions" BOOLEAN NOT NULL DEFAULT true,
    "is_accepting_bookings" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "astrologer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_rules" (
    "id" UUID NOT NULL,
    "astrologer_id" UUID NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "start_time" TIME NOT NULL,
    "end_time" TIME NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "availability_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_exceptions" (
    "id" UUID NOT NULL,
    "astrologer_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "start_time" TIME,
    "end_time" TIME,
    "is_blocked" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "availability_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "astrologer_id" UUID NOT NULL,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "status" "booking_status" NOT NULL DEFAULT 'PendingPayment',
    "price_paise" INTEGER NOT NULL,
    "payment_id" UUID,
    "meeting_link" TEXT,
    "client_note" TEXT,
    "cancelled_by" TEXT,
    "cancellation_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "astrologer_id" UUID NOT NULL,
    "question_text" TEXT NOT NULL,
    "category" TEXT,
    "status" "question_status" NOT NULL DEFAULT 'PendingPayment',
    "price_paise" INTEGER NOT NULL,
    "payment_id" UUID,
    "answer_text" TEXT,
    "answered_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "payer_id" UUID NOT NULL,
    "payee_astrologer_id" UUID,
    "amount_paise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "provider" TEXT NOT NULL,
    "provider_payment_id" TEXT,
    "provider_order_id" TEXT,
    "status" "payment_status" NOT NULL DEFAULT 'Created',
    "purpose" "payment_for" NOT NULL,
    "raw_webhook_payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_accounts_provider_provider_account_id_key" ON "oauth_accounts"("provider", "provider_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "astrologer_profiles_user_id_key" ON "astrologer_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "astrologer_profiles_slug_key" ON "astrologer_profiles"("slug");

-- AddForeignKey
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "astrologer_profiles" ADD CONSTRAINT "astrologer_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "astrologer_profiles" ADD CONSTRAINT "astrologer_profiles_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "website_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_astrologer_id_fkey" FOREIGN KEY ("astrologer_id") REFERENCES "astrologer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_astrologer_id_fkey" FOREIGN KEY ("astrologer_id") REFERENCES "astrologer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_astrologer_id_fkey" FOREIGN KEY ("astrologer_id") REFERENCES "astrologer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_astrologer_id_fkey" FOREIGN KEY ("astrologer_id") REFERENCES "astrologer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

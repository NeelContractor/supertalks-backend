-- CreateEnum
CREATE TYPE "astrologer_application_status" AS ENUM ('Submitted', 'Approved', 'Rejected');

-- CreateTable
CREATE TABLE "astrologer_applications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "astrologer_application_status" NOT NULL DEFAULT 'Submitted',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "astrologer_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "astrologer_applications_user_id_key" ON "astrologer_applications"("user_id");

-- AddForeignKey
ALTER TABLE "astrologer_applications" ADD CONSTRAINT "astrologer_applications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

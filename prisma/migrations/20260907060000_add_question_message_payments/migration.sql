-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "message_body" TEXT,
ADD COLUMN     "question_id" UUID;

-- AlterTable
ALTER TABLE "question_messages" ADD COLUMN     "payment_id" UUID;

-- CreateIndex
CREATE INDEX "payments_question_id_idx" ON "payments"("question_id");

-- CreateIndex
CREATE UNIQUE INDEX "question_messages_payment_id_key" ON "question_messages"("payment_id");

-- AddForeignKey
ALTER TABLE "question_messages" ADD CONSTRAINT "question_messages_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;


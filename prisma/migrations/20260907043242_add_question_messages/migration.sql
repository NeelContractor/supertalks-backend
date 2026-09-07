-- CreateTable
CREATE TABLE "question_messages" (
    "id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "sender_role" "user_role" NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "question_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "question_messages_question_id_created_at_idx" ON "question_messages"("question_id", "created_at");

-- AddForeignKey
ALTER TABLE "question_messages" ADD CONSTRAINT "question_messages_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_messages" ADD CONSTRAINT "question_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

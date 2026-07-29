-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "linkedWhatsapp" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_linkedWhatsapp_key" ON "Conversation"("linkedWhatsapp");

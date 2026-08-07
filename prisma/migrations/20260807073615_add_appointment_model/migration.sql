-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "doctorName" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "reminder24hSent" BOOLEAN NOT NULL DEFAULT false,
    "reminder1hSent" BOOLEAN NOT NULL DEFAULT false,
    "followUpSent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Appointment_scheduledAt_idx" ON "Appointment"("scheduledAt");

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

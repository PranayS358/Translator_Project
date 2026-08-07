-- CreateTable
CREATE TABLE "TestBooking" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "testName" TEXT NOT NULL,
    "fee" INTEGER NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "reminder24hSent" BOOLEAN NOT NULL DEFAULT false,
    "reminder1hSent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestBooking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TestBooking_scheduledAt_idx" ON "TestBooking"("scheduledAt");

-- AddForeignKey
ALTER TABLE "TestBooking" ADD CONSTRAINT "TestBooking_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

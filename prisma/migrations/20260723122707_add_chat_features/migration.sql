-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "favourite" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "muted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "unreadCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "extra" TEXT,
ADD COLUMN     "fileName" TEXT,
ADD COLUMN     "mediaUrl" TEXT,
ADD COLUMN     "messageType" TEXT NOT NULL DEFAULT 'text';

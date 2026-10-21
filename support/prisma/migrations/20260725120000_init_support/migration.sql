-- Support chat: initial schema.
--
-- Hand-written per house convention (never `prisma migrate dev` against a
-- shared DB). Applied in prod by the one-shot `migrate-support` compose
-- service running `prisma migrate deploy` straight at postgres:5432.

-- CreateEnum
CREATE TYPE "SupportProduct" AS ENUM ('PLATFORM', 'PARTNER');
CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "SupportTicketClosedBy" AS ENUM ('USER', 'AGENT', 'SYSTEM');
CREATE TYPE "SupportMessageDirection" AS ENUM ('IN', 'OUT', 'SYSTEM');
CREATE TYPE "SupportSystemKind" AS ENUM ('TICKET_OPENED', 'TICKET_CLOSED');
CREATE TYPE "SupportAttachmentKind" AS ENUM ('IMAGE', 'PDF', 'DOCUMENT');

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" UUID NOT NULL,
    "product" "SupportProduct" NOT NULL DEFAULT 'PLATFORM',
    "user_id" TEXT NOT NULL,
    "user_n_id" INTEGER NOT NULL,
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
    "closed_by" "SupportTicketClosedBy",
    "tg_chat_id" BIGINT,
    "tg_topic_id" INTEGER,
    "tg_info_message_id" INTEGER,
    "last_seq" INTEGER NOT NULL DEFAULT 0,
    "unread_for_user" INTEGER NOT NULL DEFAULT 0,
    "last_message_at" TIMESTAMPTZ,
    "last_user_message_at" TIMESTAMPTZ,
    "last_agent_message_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "closed_at" TIMESTAMPTZ,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_agents" (
    "id" UUID NOT NULL,
    "tg_user_id" BIGINT NOT NULL,
    "display_name" VARCHAR(64) NOT NULL,
    "avatar_path" VARCHAR(255),
    "title" VARCHAR(64),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "support_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_messages" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "direction" "SupportMessageDirection" NOT NULL,
    "system_kind" "SupportSystemKind",
    "text" TEXT,
    "agent_id" UUID,
    "tg_message_id" INTEGER,
    "dedupe_key" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMPTZ,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_attachments" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "message_id" UUID,
    "kind" "SupportAttachmentKind" NOT NULL,
    "storage_path" VARCHAR(255) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(128) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "tg_file_id" VARCHAR(255),
    "uploaded_by_agent" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_tg_chat_id_tg_topic_id_key" ON "support_tickets"("tg_chat_id", "tg_topic_id");
CREATE INDEX "support_tickets_product_user_id_created_at_idx" ON "support_tickets"("product", "user_id", "created_at");
CREATE INDEX "support_tickets_status_last_message_at_idx" ON "support_tickets"("status", "last_message_at");

-- At most ONE open ticket per (product, user). Enforced by the database, not
-- by application logic: a double-tapped "write to support" or a redelivered
-- Telegram update must never fork a user's thread into two topics.
CREATE UNIQUE INDEX "support_tickets_one_open_per_user"
    ON "support_tickets"("product", "user_id")
    WHERE "status" = 'OPEN';

-- CreateIndex
CREATE UNIQUE INDEX "support_agents_tg_user_id_key" ON "support_agents"("tg_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "support_messages_ticket_id_seq_key" ON "support_messages"("ticket_id", "seq");
CREATE UNIQUE INDEX "support_messages_dedupe_key_key" ON "support_messages"("dedupe_key");
CREATE INDEX "support_messages_ticket_id_created_at_idx" ON "support_messages"("ticket_id", "created_at");

-- Matching an inbound Telegram edit back to its row is a hot lookup on
-- (topic message id) — partial because IN messages relayed from the browser
-- get their tg_message_id filled in asynchronously.
CREATE INDEX "support_messages_tg_message_id_idx"
    ON "support_messages"("tg_message_id")
    WHERE "tg_message_id" IS NOT NULL;

-- CreateIndex
CREATE INDEX "support_attachments_ticket_id_created_at_idx" ON "support_attachments"("ticket_id", "created_at");
CREATE INDEX "support_attachments_message_id_idx" ON "support_attachments"("message_id");

-- AddForeignKey
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "support_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "support_attachments" ADD CONSTRAINT "support_attachments_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "support_attachments" ADD CONSTRAINT "support_attachments_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "support_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "zhora_template_drafts" (
    "id" UUID NOT NULL,
    "event_key" VARCHAR(160) NOT NULL,
    "template_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "language" VARCHAR(16) NOT NULL,
    "template_revision" INTEGER NOT NULL,
    "template_updated_at" TIMESTAMPTZ NOT NULL,
    "requested_by_tg_user_id" BIGINT NOT NULL,
    "values" JSONB NOT NULL,
    "text" TEXT,
    "missing" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "edited_before_send" BOOLEAN NOT NULL DEFAULT false,
    "preview_version" INTEGER NOT NULL DEFAULT 1,
    "preview_tg_message_id" INTEGER,
    "preview_sending_until" TIMESTAMPTZ,
    "next_chunk_index" INTEGER NOT NULL DEFAULT 0,
    "sent_by_tg_user_id" BIGINT,
    "sent_message_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "zhora_template_drafts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "zhora_template_drafts_event_key_key" ON "zhora_template_drafts"("event_key");
CREATE INDEX "zhora_template_drafts_ticket_id_created_at_idx" ON "zhora_template_drafts"("ticket_id", "created_at");

ALTER TABLE "zhora_template_drafts" ADD CONSTRAINT "zhora_template_drafts_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "zhora_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "zhora_template_drafts" ADD CONSTRAINT "zhora_template_drafts_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "zhora_template_usages" ADD COLUMN "draft_id" UUID;
CREATE UNIQUE INDEX "zhora_template_usages_draft_id_key" ON "zhora_template_usages"("draft_id");
ALTER TABLE "zhora_template_usages" ADD CONSTRAINT "zhora_template_usages_draft_id_fkey"
    FOREIGN KEY ("draft_id") REFERENCES "zhora_template_drafts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

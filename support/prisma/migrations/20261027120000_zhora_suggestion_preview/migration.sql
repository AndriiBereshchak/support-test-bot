ALTER TABLE "zhora_suggestions"
    ADD COLUMN "preview_tg_message_id" INTEGER,
    ADD COLUMN "preview_sent_at" TIMESTAMPTZ,
    ADD COLUMN "preview_sending_until" TIMESTAMPTZ,
    ADD COLUMN "next_chunk_index" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "zhora_suggestions_preview_sent_at_preview_sending_until_idx"
    ON "zhora_suggestions"("preview_sent_at", "preview_sending_until");

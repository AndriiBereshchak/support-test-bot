ALTER TABLE "zhora_suggestions"
    ADD COLUMN "outcome" VARCHAR(16),
    ADD COLUMN "sent_message_id" UUID,
    ADD COLUMN "used_variant_id" UUID,
    ADD COLUMN "final_text" TEXT,
    ADD COLUMN "rating" SMALLINT,
    ADD COLUMN "rated_at" TIMESTAMPTZ,
    ADD COLUMN "rated_by_tg_user_id" BIGINT;

CREATE UNIQUE INDEX "zhora_suggestions_sent_message_id_key"
    ON "zhora_suggestions"("sent_message_id");
CREATE INDEX "zhora_suggestions_outcome_preview_sent_at_idx"
    ON "zhora_suggestions"("outcome", "preview_sent_at");

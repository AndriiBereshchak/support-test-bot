ALTER TABLE "support_tickets"
  ADD COLUMN "detected_lang" VARCHAR(16),
  ADD COLUMN "detected_lang_seq" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "zhora_translations" (
  "message_id" UUID NOT NULL,
  "job_id" UUID,
  "detected_lang" VARCHAR(16),
  "text_ru" TEXT,
  "error_code" VARCHAR(32),
  "sent_tg_message_id" INTEGER,
  "sent_at" TIMESTAMPTZ,
  "sending_until" TIMESTAMPTZ,
  "next_chunk_index" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "zhora_translations_pkey" PRIMARY KEY ("message_id"),
  CONSTRAINT "zhora_translations_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "support_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "zhora_translations_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "zhora_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "zhora_translations_job_id_key" ON "zhora_translations"("job_id");
CREATE INDEX "zhora_translations_sent_at_sending_until_idx" ON "zhora_translations"("sent_at", "sending_until");

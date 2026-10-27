ALTER TABLE "zhora_suggestions"
    ADD COLUMN "candidate_checked_at" TIMESTAMPTZ;
CREATE INDEX "zhora_suggestions_candidate_checked_at_created_at_idx"
    ON "zhora_suggestions"("candidate_checked_at", "created_at");

CREATE TABLE "zhora_kb_candidates" (
    "id" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "origin_domain" VARCHAR(255),
    "embedding" public.vector(1024),
    "embedding_model" VARCHAR(160) NOT NULL,
    "draft_answer_ru" TEXT,
    "draft_source_message_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "draft_job_id" UUID,
    "draft_processed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "zhora_kb_candidates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "zhora_kb_candidate_occurrences" (
    "message_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "suggestion_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "zhora_kb_candidate_occurrences_pkey" PRIMARY KEY ("message_id")
);

CREATE UNIQUE INDEX "zhora_kb_candidates_draft_job_id_key"
    ON "zhora_kb_candidates"("draft_job_id");
CREATE INDEX "zhora_kb_candidate_occurrences_candidate_id_idx"
    ON "zhora_kb_candidate_occurrences"("candidate_id");

ALTER TABLE "zhora_kb_candidates" ADD CONSTRAINT "zhora_kb_candidates_draft_job_id_fkey"
    FOREIGN KEY ("draft_job_id") REFERENCES "zhora_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "zhora_kb_candidate_occurrences" ADD CONSTRAINT "zhora_kb_candidate_occurrences_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "support_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "zhora_kb_candidate_occurrences" ADD CONSTRAINT "zhora_kb_candidate_occurrences_candidate_id_fkey"
    FOREIGN KEY ("candidate_id") REFERENCES "zhora_kb_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

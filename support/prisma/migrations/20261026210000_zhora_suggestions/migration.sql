CREATE TABLE "zhora_suggestions" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "target_message_id" UUID NOT NULL,
    "language" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zhora_suggestions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "zhora_suggestions_job_id_key" ON "zhora_suggestions"("job_id");
CREATE INDEX "zhora_suggestions_target_message_id_created_at_idx" ON "zhora_suggestions"("target_message_id", "created_at");

ALTER TABLE "zhora_suggestions" ADD CONSTRAINT "zhora_suggestions_job_id_fkey"
    FOREIGN KEY ("job_id") REFERENCES "zhora_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "zhora_suggestions" ADD CONSTRAINT "zhora_suggestions_target_message_id_fkey"
    FOREIGN KEY ("target_message_id") REFERENCES "support_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

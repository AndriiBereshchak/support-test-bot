ALTER TABLE "zhora_jobs"
  ADD COLUMN "brief_sent_at" TIMESTAMPTZ,
  ADD COLUMN "brief_sending_until" TIMESTAMPTZ;

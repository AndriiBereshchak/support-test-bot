-- Additive durable AI jobs; existing support tables and enums are unchanged.
-- CreateTable
CREATE TABLE "zhora_jobs" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "event_key" VARCHAR(160) NOT NULL,
    "operation" VARCHAR(32) NOT NULL,
    "input" JSONB NOT NULL,
    "ticket_id" UUID,
    "agent_id" UUID,
    "call_id" UUID,
    "status" VARCHAR(24) NOT NULL DEFAULT 'queued',
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "lease_expires_at" TIMESTAMPTZ,
    "result" JSONB,
    "error_code" VARCHAR(64),

    CONSTRAINT "zhora_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "zhora_jobs_event_key_key" ON "zhora_jobs"("event_key");

-- CreateIndex
CREATE UNIQUE INDEX "zhora_jobs_call_id_key" ON "zhora_jobs"("call_id");

-- CreateIndex
CREATE INDEX "zhora_jobs_status_created_at_idx" ON "zhora_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "zhora_jobs_status_lease_expires_at_idx" ON "zhora_jobs"("status", "lease_expires_at");

-- AddForeignKey
ALTER TABLE "zhora_jobs" ADD CONSTRAINT "zhora_jobs_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zhora_jobs" ADD CONSTRAINT "zhora_jobs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "support_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zhora_jobs" ADD CONSTRAINT "zhora_jobs_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "zhora_llm_calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;


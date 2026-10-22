-- Additive AI metadata and budget storage. No existing enums or rows are changed.
-- CreateTable
CREATE TABLE "zhora_llm_calls" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "operation" VARCHAR(32) NOT NULL,
    "model" VARCHAR(160) NOT NULL,
    "ticket_id" UUID,
    "agent_id" UUID,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cost_usd" DECIMAL(24,12),
    "duration_ms" INTEGER,
    "outcome" VARCHAR(32),

    CONSTRAINT "zhora_llm_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zhora_monthly_budgets" (
    "month" VARCHAR(7) NOT NULL,
    "spent_usd" DECIMAL(24,12) NOT NULL DEFAULT 0,
    "exhausted_at" TIMESTAMPTZ,
    "notified_at" TIMESTAMPTZ,

    CONSTRAINT "zhora_monthly_budgets_pkey" PRIMARY KEY ("month")
);

-- CreateIndex
CREATE INDEX "zhora_llm_calls_created_at_idx" ON "zhora_llm_calls"("created_at");

-- CreateIndex
CREATE INDEX "zhora_llm_calls_operation_created_at_idx" ON "zhora_llm_calls"("operation", "created_at");

-- CreateIndex
CREATE INDEX "zhora_llm_calls_ticket_id_created_at_idx" ON "zhora_llm_calls"("ticket_id", "created_at");

-- AddForeignKey
ALTER TABLE "zhora_llm_calls" ADD CONSTRAINT "zhora_llm_calls_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zhora_llm_calls" ADD CONSTRAINT "zhora_llm_calls_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "support_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;


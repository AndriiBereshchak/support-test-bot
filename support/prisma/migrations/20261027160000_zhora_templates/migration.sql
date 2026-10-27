CREATE TABLE "zhora_templates" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "category" VARCHAR(128) NOT NULL,
    "text_ru" TEXT NOT NULL,
    "variables" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updated_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "zhora_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "zhora_templates_code_key" ON "zhora_templates"("code");
CREATE INDEX "zhora_templates_category_code_idx" ON "zhora_templates"("category", "code");

CREATE TABLE "zhora_template_translations" (
    "template_id" UUID NOT NULL,
    "language" VARCHAR(16) NOT NULL,
    "text" TEXT,
    "source_hash" VARCHAR(64) NOT NULL,
    "is_manual" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "zhora_template_translations_pkey" PRIMARY KEY ("template_id", "language")
);

ALTER TABLE "zhora_template_translations" ADD CONSTRAINT "zhora_template_translations_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "zhora_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "zhora_template_usages" (
    "id" UUID NOT NULL,
    "template_id" UUID,
    "template_code" VARCHAR(64) NOT NULL,
    "ticket_id" UUID,
    "agent_id" UUID,
    "operator_tg_user_id" BIGINT NOT NULL,
    "edited_before_send" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "zhora_template_usages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "zhora_template_usages_template_id_created_at_idx" ON "zhora_template_usages"("template_id", "created_at");
CREATE INDEX "zhora_template_usages_ticket_id_created_at_idx" ON "zhora_template_usages"("ticket_id", "created_at");

ALTER TABLE "zhora_template_usages" ADD CONSTRAINT "zhora_template_usages_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "zhora_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "zhora_template_usages" ADD CONSTRAINT "zhora_template_usages_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "zhora_template_usages" ADD CONSTRAINT "zhora_template_usages_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "support_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

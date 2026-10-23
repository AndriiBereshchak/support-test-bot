-- Additive KB storage only. Existing tables and enums are unchanged.
-- CreateTable
CREATE TABLE "zhora_kb_entries" (
    "id" UUID NOT NULL,
    "questions" TEXT[],
    "answer_ru" TEXT NOT NULL,
    "translations" JSONB NOT NULL,
    "tag" TEXT NOT NULL,
    "domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" VARCHAR(16) NOT NULL DEFAULT 'draft',
    "updated_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "zhora_kb_entries_pkey" PRIMARY KEY ("id")
);


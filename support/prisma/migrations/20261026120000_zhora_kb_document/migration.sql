-- Initial KB setup, before importing any entries.
ALTER TABLE "zhora_kb_entries"
    ADD COLUMN "notes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "dynamic_fields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "ask_user" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "is_temporary" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "question" TEXT NOT NULL,
    ADD COLUMN "variants" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "zhora_kb_entries" RENAME COLUMN "tag" TO "category";

ALTER TABLE "zhora_kb_entries" DROP COLUMN "questions";


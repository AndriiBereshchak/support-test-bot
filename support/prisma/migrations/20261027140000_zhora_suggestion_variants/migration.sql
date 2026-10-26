ALTER TABLE "zhora_suggestions"
    ADD COLUMN "source_suggestion_id" UUID;

CREATE UNIQUE INDEX "zhora_suggestions_source_suggestion_id_language_key"
    ON "zhora_suggestions"("source_suggestion_id", "language");

ALTER TABLE "zhora_suggestions"
    ADD CONSTRAINT "zhora_suggestions_source_suggestion_id_fkey"
    FOREIGN KEY ("source_suggestion_id") REFERENCES "zhora_suggestions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

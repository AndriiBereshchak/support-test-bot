-- The PostgreSQL host must have pgvector >= 0.8 installed before deployment.
-- Public placement keeps the type/operators available to isolated test schemas.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

ALTER TABLE "zhora_kb_entries"
    ADD COLUMN "embedding" public.vector(1024),
    ADD COLUMN "embedding_model" TEXT,
    ADD COLUMN "embedding_hash" VARCHAR(32),
    ADD COLUMN "embedding_indexed_at" TIMESTAMPTZ;

CREATE INDEX "zhora_kb_entries_embedding_hnsw_idx"
    ON "zhora_kb_entries" USING hnsw ("embedding" public.vector_cosine_ops)
    WHERE "status" = 'active';

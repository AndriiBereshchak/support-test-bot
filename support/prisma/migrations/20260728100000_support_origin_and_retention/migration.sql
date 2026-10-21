-- Origin mirror on the ticket + attachment retention bookkeeping.
--
-- Both columns are nullable with no default, so this is a metadata-only change:
-- no table rewrite, no lock beyond the catalog update, safe on a live table.

-- Which mirror the user wrote from (binodex.io / .pro / .app / …). Filled by
-- the exchange proxy from the request Origin; NULL on rows written before this
-- migration and on any path where the header was absent.
ALTER TABLE "support_tickets" ADD COLUMN "origin_domain" VARCHAR(255);

-- Stamped by the retention sweeper when the bytes are unlinked from disk. The
-- row itself is never deleted — the conversation must keep showing that a file
-- was sent, and the Telegram copy stays available to support forever.
ALTER TABLE "support_attachments" ADD COLUMN "purged_at" TIMESTAMPTZ;

-- The sweeper's working set: rows still holding bytes, oldest first. PARTIAL on
-- purged_at IS NULL so the index covers only actionable rows and shrinks as
-- files age out, rather than growing forever alongside the archive.
CREATE INDEX "support_attachments_retention_idx"
    ON "support_attachments"("created_at")
    WHERE "purged_at" IS NULL;

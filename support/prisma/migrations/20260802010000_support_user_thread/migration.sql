-- One Telegram topic per USER instead of per ticket.
--
-- Two independent changes, both safe on a live service:
--
-- 1. The ticket-level unique index on (tg_chat_id, tg_topic_id) is what made
--    "one topic, many tickets" impossible. Dropped and replaced by a plain
--    index — the lookup it served ("which ticket does this topic mean?") is
--    still needed, the exclusivity is not.
--
-- 2. A new table owns the per-user binding. Nothing is backfilled: existing
--    tickets keep their own topic ids and keep working in the topics they were
--    opened in. New conversations bind to the user's permanent topic, which is
--    created on their next message.
DROP INDEX IF EXISTS "support_tickets_tg_chat_id_tg_topic_id_key";

CREATE INDEX IF NOT EXISTS "support_tickets_tg_chat_id_tg_topic_id_idx"
  ON "support_tickets" ("tg_chat_id", "tg_topic_id");

CREATE TABLE IF NOT EXISTS "support_user_threads" (
  "id"                 UUID NOT NULL,
  "product"            "SupportProduct" NOT NULL DEFAULT 'PLATFORM',
  "user_id"            TEXT NOT NULL,
  "user_n_id"          INTEGER NOT NULL,
  "tg_chat_id"         BIGINT,
  "tg_topic_id"        INTEGER,
  "tg_info_message_id" INTEGER,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ NOT NULL,
  CONSTRAINT "support_user_threads_pkey" PRIMARY KEY ("id")
);

-- The invariant the old ticket-level index used to carry, moved to where it
-- belongs: one permanent topic per user, and one user per topic.
CREATE UNIQUE INDEX IF NOT EXISTS "support_user_threads_product_user_id_key"
  ON "support_user_threads" ("product", "user_id");

CREATE UNIQUE INDEX IF NOT EXISTS "support_user_threads_tg_chat_id_tg_topic_id_key"
  ON "support_user_threads" ("tg_chat_id", "tg_topic_id");

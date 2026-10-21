-- Operator tools bot: append-only audit trail.
--
-- Every action performed through the internal operator bot is recorded:
-- who (Telegram numeric id + display name at the time), what (action slug),
-- with which parameters (jsonb), and the outcome. Nothing ever updates or
-- deletes these rows.

CREATE TABLE "operator_actions" (
    "id"         TEXT         NOT NULL,
    "created_at" TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tg_user_id" BIGINT       NOT NULL,
    "tg_name"    VARCHAR(128) NOT NULL,
    "action"     VARCHAR(64)  NOT NULL,
    "params"     JSONB,
    "result"     VARCHAR(32),

    CONSTRAINT "operator_actions_pkey" PRIMARY KEY ("id")
);

-- "What did this operator do lately" — the primary read.
CREATE INDEX "operator_actions_tg_user_id_created_at_idx"
    ON "operator_actions"("tg_user_id", "created_at");

-- "Who deleted accounts this month" — the secondary read.
CREATE INDEX "operator_actions_action_created_at_idx"
    ON "operator_actions"("action", "created_at");

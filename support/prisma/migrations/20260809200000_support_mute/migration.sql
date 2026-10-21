-- Временный запрет писать в поддержку.
--
-- Одна строка на пользователя и переиспользуется: история «кто и за что» ведётся
-- в operator_actions, а лента блокировок здесь заставляла бы каждый раз выбирать
-- из неё актуальную — и рано или поздно выбрать не ту.
--
-- Снятие — это muted_until = NULL, а не удаление строки: видно, что человека
-- когда-то ограничивали, и кто снял.
CREATE TABLE "support_mutes" (
    "id"                  UUID NOT NULL,
    "product"             "SupportProduct" NOT NULL DEFAULT 'PLATFORM',
    "user_id"             TEXT NOT NULL,
    "user_n_id"           INTEGER NOT NULL,
    "muted_until"         TIMESTAMPTZ,
    "reason"              VARCHAR(500),
    "muted_by_agent_id"   UUID,
    "muted_at"            TIMESTAMPTZ,
    "unmuted_by_agent_id" UUID,
    "unmuted_at"          TIMESTAMPTZ,
    "created_at"          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_mutes_pkey" PRIMARY KEY ("id")
);

-- Один запрет на (продукт, пользователя): upsert по нему и делает повторную
-- блокировку продлением, а не второй строкой.
CREATE UNIQUE INDEX "support_mutes_product_user_id_key"
    ON "support_mutes"("product", "user_id");

-- «Кого сейчас ограничивают» — единственный запрос по сроку.
CREATE INDEX "support_mutes_muted_until_idx" ON "support_mutes"("muted_until");

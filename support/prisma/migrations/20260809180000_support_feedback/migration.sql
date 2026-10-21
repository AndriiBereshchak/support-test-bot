-- Оценка работы поддержки после закрытия диалога.
--
-- Живёт на тикете, а не на пользователе: оценивают конкретный разговор, и у
-- одного человека их может быть много с разными оценками. `rated_at` отдельно
-- от `rating` — по нему определяется «уже спрашивали», и он же даёт срез по
-- времени, не завися от того, поставил ли человек оценку.
ALTER TABLE "support_tickets"
  ADD COLUMN "rating"         SMALLINT,
  ADD COLUMN "rating_comment" VARCHAR(2000),
  ADD COLUMN "rated_at"       TIMESTAMPTZ;

-- Диапазон проверяется и в приложении, но это последняя линия: оценка попадёт
-- в аналитику, и «7 звёзд» там дороже отвергнутого запроса.
ALTER TABLE "support_tickets"
  ADD CONSTRAINT "support_tickets_rating_range"
  CHECK ("rating" IS NULL OR ("rating" >= 1 AND "rating" <= 5));

-- Выборка «что оценили за период» и «сколько закрытых без оценки» — оба
-- запроса идут по этой колонке.
CREATE INDEX "support_tickets_rated_at_idx" ON "support_tickets"("rated_at");

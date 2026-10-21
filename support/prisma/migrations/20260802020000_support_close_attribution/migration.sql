-- Who closed the ticket, not just "a human did".
--
-- A nullable COLUMN, so an old container reading these rows during a blue/green
-- cutover never sees it (Prisma selects columns explicitly) — same reasoning as
-- the auto-message and sticker columns.
--
-- Not backfilled: tickets closed before this shipped have no attribution and
-- honestly cannot get one. Dashboards count them under "не атрибутировано"
-- rather than silently assigning them to someone.
ALTER TABLE "support_tickets"
  ADD COLUMN IF NOT EXISTS "closed_by_agent_id" UUID;

-- The per-operator dashboards group by this column over a time range.
CREATE INDEX IF NOT EXISTS "support_tickets_closed_by_agent_idx"
  ON "support_tickets" ("closed_by_agent_id", "closed_at");

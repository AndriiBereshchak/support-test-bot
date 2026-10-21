-- Tie the operator audit trail into the support system proper.
--
-- Until now a row carried only the Telegram id and a display name, which made
-- it a table of loose strings: you could not join an action to the operator the
-- rest of the system knows, nor to the conversation it was taken from.
--
-- Both columns are NULLABLE and both drop to NULL on delete, deliberately:
--   * an action taken by somebody who never registered as an agent must still
--     be recorded — the Telegram id stays the identity of record;
--   * an audit row must OUTLIVE the ticket and the agent it points at. ON
--     DELETE CASCADE here would let closing an account erase the evidence of
--     who closed it.

ALTER TABLE "operator_actions"
  ADD COLUMN "agent_id"  UUID,
  ADD COLUMN "ticket_id" UUID;

ALTER TABLE "operator_actions"
  ADD CONSTRAINT "operator_actions_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "support_agents"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "operator_actions"
  ADD CONSTRAINT "operator_actions_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "operator_actions_ticket_id_created_at_idx"
  ON "operator_actions" ("ticket_id", "created_at");

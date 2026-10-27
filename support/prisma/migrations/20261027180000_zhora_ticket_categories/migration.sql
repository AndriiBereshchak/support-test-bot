CREATE TYPE "SupportTicketCategory" AS ENUM (
    'DEPOSIT', 'WITHDRAWAL', 'ACCOUNT', 'VERIFICATION',
    'TRADING', 'PARTNERSHIP', 'APP', 'OTHER'
);

ALTER TABLE "support_tickets"
    ADD COLUMN "category" "SupportTicketCategory",
    ADD COLUMN "category_manual" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "category_attempt" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "category_job_id" UUID,
    ADD COLUMN "category_classify_pending" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "support_tickets_category_classify_pending_category_job_id_idx"
    ON "support_tickets"("category_classify_pending", "category_job_id");

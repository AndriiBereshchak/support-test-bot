-- Support's automatic replies, and stickers.
--
-- COLUMNS, not new enum values, and that is the whole point of this migration's
-- shape. Support is released blue/green: the old container keeps serving while
-- the new one already writes. A Prisma client throws on an enum value it was
-- not generated with, so extending SupportSystemKind / SupportAttachmentKind
-- would break live conversations for the length of the cutover — verified
-- against the real client, not assumed. An unknown COLUMN is invisible to it,
-- because Prisma selects columns explicitly.
--
-- Both are additive and nullable/defaulted, so the old code writes rows that
-- the new code reads correctly, and vice versa.
ALTER TABLE "support_messages"
  ADD COLUMN IF NOT EXISTS "auto_kind" VARCHAR(32);

ALTER TABLE "support_attachments"
  ADD COLUMN IF NOT EXISTS "is_sticker" BOOLEAN NOT NULL DEFAULT false;

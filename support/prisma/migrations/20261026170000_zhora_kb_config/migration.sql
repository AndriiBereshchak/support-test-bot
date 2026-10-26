CREATE TABLE "zhora_kb_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "full_version_url" TEXT NOT NULL,
    "ios_url" TEXT NOT NULL,
    "android_url" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "zhora_kb_config_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "zhora_kb_config_single_row" CHECK ("id" = 1)
);

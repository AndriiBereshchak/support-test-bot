# backend/support — выгрузка для разработки Жоры

Источник: binodex/backend, ветка main, коммит 643ae88 (2026-10-20).
Только папка support/ — сервис поддержки (Telegram-мост + operator-команды). Read-only снимок, не для деплоя.

Что внутри:
- src/telegram/ — webhook-роутер (updates.ts), команды операторов (commands.ts), Bot API обёртка и инфо-карточка (api.ts)
- src/apps/services/ — тикеты, сообщения, вложения, мьют, отзывы, напоминания, sweeper
- src/core/contracts.ts — формат данных, общий с platform-web
- prisma/schema.prisma — своя БД поддержки
- tests/

Чего НЕТ (живёт в других частях монорепо):
- exchange/prisma — схема exchange (support читает оттуда юзера, баланс, депозиты через @prisma-exchange, read-only)
- прокси exchange -> support (/v1/support-chat/*, /v1/support/tg-webhook)
- секреты: только .env.example

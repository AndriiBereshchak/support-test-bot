import type { SupportTicketCategory } from '@prisma-support'

export const TICKET_CATEGORIES: ReadonlyArray<{
  code: SupportTicketCategory
  label: string
}> = [
  { code: 'DEPOSIT', label: 'Депозит' },
  { code: 'WITHDRAWAL', label: 'Вывод' },
  { code: 'ACCOUNT', label: 'Вход/аккаунт' },
  { code: 'VERIFICATION', label: 'Верификация' },
  { code: 'TRADING', label: 'Торговля' },
  { code: 'PARTNERSHIP', label: 'Партнёрка' },
  { code: 'APP', label: 'Приложение' },
  { code: 'OTHER', label: 'Другое' },
]

export function isTicketCategory(
  value: string
): value is SupportTicketCategory {
  return TICKET_CATEGORIES.some((item) => item.code === value)
}

export function ticketCategoryLabel(category: SupportTicketCategory): string {
  return TICKET_CATEGORIES.find((item) => item.code === category)!.label
}

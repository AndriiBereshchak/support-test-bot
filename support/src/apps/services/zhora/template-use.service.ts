import { AccountKind } from '@prisma-exchange'
import { Prisma } from '@prisma-support'
import { prismaExchange, prismaSupport } from '@config/database'
import { ApiError } from '@core/errors/api-error'
import { getUserCard } from '../user-card.service'
import { listUserDeposits } from '../deposit-list.service'
import { listUserWithdrawals } from '../withdrawal-list.service'
import {
  sourceHash,
  ZHORA_TEMPLATE_TRANSLATION_LANGUAGES,
} from './template.service'

type Values = Record<string, string>

const SUPPORTED_LANGUAGES = new Set<string>([
  'ru',
  ...ZHORA_TEMPLATE_TRANSLATION_LANGUAGES,
])

export function templateLanguageText(
  template: {
    textRu: string
    translations: Array<{
      language: string
      text: string | null
      sourceHash: string
    }>
  },
  language: string,
  sourceHash: string
): string | null {
  if (language === 'ru') return template.textRu
  const row = template.translations.find((item) => item.language === language)
  return row?.text && row.sourceHash === sourceHash ? row.text : null
}

export function renderTemplate(text: string, values: Values) {
  const missing = new Set<string>()
  const rendered = text.replace(/\{([^{}]+)\}/g, (full, name: string) => {
    const value = values[name]?.trim()
    if (value) return value
    missing.add(name)
    return full
  })
  return {
    text: missing.size ? null : rendered,
    partial: rendered,
    missing: [...missing],
  }
}

function readValues(value: Prisma.JsonValue): Values {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError('Черновик шаблона недоступен.', 409)
  const result: Values = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string')
      throw new ApiError('Черновик шаблона недоступен.', 409)
    result[key] = item
  }
  return result
}

async function confirmedValues(args: {
  ticket: { userId: string; userNId: number; originDomain: string | null }
  agentId: string | null
  variables: string[]
}): Promise<Values> {
  const wanted = new Set(args.variables)
  const values: Values = {}
  if (wanted.has('nId')) values.nId = String(args.ticket.userNId)
  if (wanted.has('domain') && args.ticket.originDomain)
    values.domain = args.ticket.originDomain
  if (wanted.has('operator_name') && args.agentId) {
    const agent = await prismaSupport.supportAgent.findUnique({
      where: { id: args.agentId },
      select: { displayName: true },
    })
    if (agent?.displayName.trim())
      values.operator_name = agent.displayName.trim()
  }
  if ([...wanted].some((name) => ['name', 'email', 'balance'].includes(name))) {
    try {
      const card = await getUserCard(args.ticket.userId, {
        requireComplete: true,
      })
      if (wanted.has('name') && card.fullName.trim())
        values.name = card.fullName.trim()
      if (wanted.has('email') && card.email.trim())
        values.email = card.email.trim()
      if (wanted.has('balance')) {
        const account = await prismaExchange.account.findFirst({
          where: {
            userId: args.ticket.userId,
            kind: AccountKind.USER,
            isDemo: false,
          },
          select: { id: true },
        })
        if (account) values.balance = card.balanceReal.trim()
      }
    } catch {
      // Unavailable facts remain missing; the operator may enter them explicitly.
    }
  }
  if (wanted.has('last_deposit')) {
    const deposits = await listUserDeposits(args.ticket.userId)
    const last = deposits?.find((row) => !row.isFake)
    if (last) values.last_deposit = `${last.amount} ${last.currency}`
  }
  if (wanted.has('last_withdrawal') || wanted.has('withdrawal_status')) {
    const withdrawals = await listUserWithdrawals(args.ticket.userId)
    const last = withdrawals?.find((row) => !row.isFake)
    if (last) {
      if (wanted.has('last_withdrawal')) values.last_withdrawal = last.amount
      if (wanted.has('withdrawal_status') && last.status.trim())
        values.withdrawal_status = last.status.trim()
    }
  }
  return values
}

const include = { template: { include: { translations: true } } } as const

export async function requestTemplateDraft(args: {
  eventKey: string
  ticket: {
    id: string
    userId: string
    userNId: number
    originDomain: string | null
    detectedLang: string | null
  }
  agentId: string | null
  fromId: number
  templateId: string
}) {
  const existing = await prismaSupport.zhoraTemplateDraft.findUnique({
    where: { eventKey: args.eventKey },
    include,
  })
  if (existing) return existing
  const template = await prismaSupport.zhoraTemplate.findUnique({
    where: { id: args.templateId },
    include: { translations: true },
  })
  if (!template) throw new ApiError('Шаблон не найден.', 404)
  const language = args.ticket.detectedLang
  if (!language || !SUPPORTED_LANGUAGES.has(language))
    throw new ApiError('Шаблон недоступен на языке этого тикета.', 409)
  const hash = sourceHash(template.textRu)
  const source = templateLanguageText(template, language, hash)
  if (!source)
    throw new ApiError(
      'Перевод шаблона ещё не готов или требует проверки.',
      409
    )
  const values = await confirmedValues({
    ticket: args.ticket,
    agentId: args.agentId,
    variables: template.variables,
  })
  const rendered = renderTemplate(source, values)
  try {
    return await prismaSupport.zhoraTemplateDraft.create({
      data: {
        eventKey: args.eventKey,
        templateId: template.id,
        ticketId: args.ticket.id,
        language,
        templateRevision: template.revision,
        templateUpdatedAt: template.updatedAt,
        requestedByTgUserId: BigInt(args.fromId),
        values,
        text: rendered.text,
        missing: rendered.missing,
      },
      include,
    })
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const duplicate = await prismaSupport.zhoraTemplateDraft.findUnique({
        where: { eventKey: args.eventKey },
        include,
      })
      if (duplicate) return duplicate
    }
    throw error
  }
}

export async function updateTemplateDraft(args: {
  id: string
  ticketId: string
  previewMessageId: number
  fromId: number
  operation:
    | { kind: 'fill'; name: string; value: string }
    | { kind: 'edit'; text: string }
}) {
  return prismaSupport.$transaction(async (tx) => {
    const draft = await tx.zhoraTemplateDraft.findUnique({
      where: { id: args.id },
      include,
    })
    if (
      !draft ||
      draft.ticketId !== args.ticketId ||
      draft.previewTgMessageId !== args.previewMessageId ||
      draft.sentMessageId ||
      draft.sentByTgUserId ||
      (draft.template.variables.includes('operator_name') &&
        draft.requestedByTgUserId !== BigInt(args.fromId)) ||
      draft.template.revision !== draft.templateRevision ||
      draft.template.updatedAt.getTime() !== draft.templateUpdatedAt.getTime()
    )
      throw new ApiError('Черновик шаблона устарел. Вызовите /t снова.', 409)
    let text: string | null
    let missing: string[]
    let values = readValues(draft.values)
    if (args.operation.kind === 'fill') {
      if (!draft.missing.includes(args.operation.name))
        throw new ApiError('Эту переменную заполнять не нужно.', 400)
      const raw = args.operation.value.trim()
      const value =
        raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1).trim() : raw
      if (!value || value.length > 500 || /[{}]/.test(value))
        throw new ApiError(
          'Укажите значение без фигурных скобок (до 500 символов).',
          400
        )
      values = { ...values, [args.operation.name]: value }
      const hash = sourceHash(draft.template.textRu)
      const source = templateLanguageText(draft.template, draft.language, hash)
      if (!source)
        throw new ApiError(
          'Перевод шаблона больше недоступен. Вызовите /t снова.',
          409
        )
      const rendered = renderTemplate(source, values)
      text = rendered.text
      missing = rendered.missing
    } else {
      text = args.operation.text.trim()
      if (!draft.text || !text || text.length > 4096 || /[{}]/.test(text))
        throw new ApiError(
          'Сначала заполните переменные, затем укажите готовый текст без фигурных скобок.',
          400
        )
      missing = []
    }
    const changed = await tx.zhoraTemplateDraft.updateMany({
      where: {
        id: draft.id,
        previewVersion: draft.previewVersion,
        previewTgMessageId: args.previewMessageId,
        sentMessageId: null,
        sentByTgUserId: null,
      },
      data: {
        values,
        text,
        missing,
        editedBeforeSend: draft.editedBeforeSend || args.operation.kind === 'edit',
        previewVersion: { increment: 1 },
        previewTgMessageId: null,
        previewSendingUntil: null,
        nextChunkIndex: 0,
      },
    })
    if (!changed.count)
      throw new ApiError('Черновик уже изменён. Откройте новое превью.', 409)
    return tx.zhoraTemplateDraft.findUniqueOrThrow({
      where: { id: draft.id },
      include,
    })
  })
}

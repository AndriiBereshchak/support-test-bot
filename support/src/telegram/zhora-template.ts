import { prismaSupport } from '@config/database'
import { logger } from '@config/logger'
import { ApiError } from '@core/errors/api-error'
import { agentSendMessage } from '@apps/services/chat.service'
import {
  renderTemplate,
  requestTemplateDraft,
  templateLanguageText,
  updateTemplateDraft,
} from '@apps/services/zhora/template-use.service'
import { sourceHash } from '@apps/services/zhora/template.service'
import { splitText } from './text'
import {
  sendPlainMessage,
  ZHORA_TEMPLATE_CATEGORY_CALLBACK_PREFIX,
  ZHORA_TEMPLATE_SELECT_CALLBACK_PREFIX,
  ZHORA_TEMPLATE_SEND_CALLBACK_PREFIX,
} from './api'
import { prepareZhoraInvocation } from './zhora'

type OperatorContext = {
  chatId: number
  topicId: number | null
  fromId: number
  isBot?: boolean
}

const PREVIEW_LEASE_MS = 60_000

function note(ctx: OperatorContext, text: string) {
  return sendPlainMessage({ chatId: ctx.chatId, topicId: ctx.topicId, text })
}

async function categories() {
  const rows = await prismaSupport.zhoraTemplate.findMany({
    select: { category: true },
    distinct: ['category'],
    orderBy: { category: 'asc' },
  })
  return rows.map((row) => row.category)
}

function categoryKey(category: string) {
  return sourceHash(category).slice(0, 16)
}

export async function showTemplateCategories(ctx: OperatorContext) {
  if (!(await prepareZhoraInvocation(ctx))) return
  const list = await categories()
  if (!list.length) {
    await note(ctx, 'Шаблонов пока нет.')
    return
  }
  for (let offset = 0; offset < list.length; offset += 100) {
    const sent = await sendPlainMessage({
      chatId: ctx.chatId,
      topicId: ctx.topicId,
      text: 'Выберите категорию шаблонов. Для прямого поиска используйте /t <код>.',
      replyMarkup: {
        inline_keyboard: list.slice(offset, offset + 100).map((category) => [
          {
            text: category.slice(0, 64),
            callback_data: `${ZHORA_TEMPLATE_CATEGORY_CALLBACK_PREFIX}${categoryKey(category)}`,
          },
        ]),
      },
    })
    if (!sent) break
  }
}

export async function showTemplateCategory(
  ctx: OperatorContext & { categoryKey: string }
) {
  if (!(await prepareZhoraInvocation(ctx))) return
  const category = (await categories()).find(
    (item) => categoryKey(item) === ctx.categoryKey
  )
  if (!category) {
    await note(ctx, 'Категория больше недоступна. Вызовите /t снова.')
    return
  }
  const templates = await prismaSupport.zhoraTemplate.findMany({
    where: { category },
    select: { id: true, code: true },
    orderBy: { code: 'asc' },
  })
  if (!templates.length) {
    await note(ctx, 'В этой категории нет шаблонов.')
    return
  }
  for (let offset = 0; offset < templates.length; offset += 100) {
    const sent = await sendPlainMessage({
      chatId: ctx.chatId,
      topicId: ctx.topicId,
      text: `Шаблоны «${category}». Выберите код или используйте /t <код>.`,
      replyMarkup: {
        inline_keyboard: templates
          .slice(offset, offset + 100)
          .map((template) => [
            {
              text: template.code,
              callback_data: `${ZHORA_TEMPLATE_SELECT_CALLBACK_PREFIX}${template.id}`,
            },
          ]),
      },
    })
    if (!sent) break
  }
}

const draftInclude = { template: { include: { translations: true } } } as const

type Draft = NonNullable<Awaited<ReturnType<typeof requestTemplateDraft>>>

async function showDraftPreview(ctx: OperatorContext, draft: Draft) {
  if (draft.previewTgMessageId || draft.sentMessageId) return
  const current = await prismaSupport.zhoraTemplateDraft.findUnique({
    where: { id: draft.id },
    include: draftInclude,
  })
  if (
    !current ||
    current.templateRevision !== current.template.revision ||
    current.template.updatedAt.getTime() !== current.templateUpdatedAt.getTime()
  ) {
    await note(ctx, 'Шаблон изменился. Вызовите /t снова.')
    return
  }
  const source = templateLanguageText(
    current.template,
    current.language,
    sourceHash(current.template.textRu)
  )
  if (!source) {
    await note(ctx, 'Перевод шаблона недоступен. Вызовите /t снова.')
    return
  }
  const values = current.values as Record<string, string>
  const partial = renderTemplate(source, values).partial
  const body = [
    `Жора — шаблон ${current.template.code} (${current.language})`,
    current.text ?? partial,
    current.missing.length
      ? `Не хватает: ${current.missing.join(', ')}. Ответьте на это превью командой /t имя_переменной="значение". Клиент ничего не получит.`
      : 'Проверьте текст. Чтобы изменить его, ответьте на это превью командой /t edit <готовый текст>.',
  ].join('\n\n')
  const chunks = splitText(body)
  const now = new Date()
  const claimed = await prismaSupport.zhoraTemplateDraft.updateMany({
    where: {
      id: current.id,
      previewVersion: current.previewVersion,
      previewTgMessageId: null,
      OR: [{ previewSendingUntil: null }, { previewSendingUntil: { lt: now } }],
    },
    data: { previewSendingUntil: new Date(Date.now() + PREVIEW_LEASE_MS) },
  })
  if (!claimed.count) return
  for (let index = current.nextChunkIndex; index < chunks.length; index++) {
    const final = index === chunks.length - 1
    const sentId = await sendPlainMessage({
      chatId: ctx.chatId,
      topicId: ctx.topicId,
      text: chunks[index]!,
      ...(final && current.text && !current.missing.length
        ? {
            replyMarkup: {
              inline_keyboard: [
                [
                  {
                    text: 'Отправить',
                    callback_data: `${ZHORA_TEMPLATE_SEND_CALLBACK_PREFIX}${current.id}:${current.previewVersion}`,
                  },
                ],
              ],
            },
          }
        : {}),
    })
    if (!sentId) {
      await prismaSupport.zhoraTemplateDraft.updateMany({
        where: { id: current.id, previewVersion: current.previewVersion },
        data: { previewSendingUntil: null },
      })
      return
    }
    await prismaSupport.zhoraTemplateDraft.updateMany({
      where: { id: current.id, previewVersion: current.previewVersion },
      data: {
        nextChunkIndex: index + 1,
        previewTgMessageId: final ? sentId : null,
        previewSendingUntil: final
          ? null
          : new Date(Date.now() + PREVIEW_LEASE_MS),
      },
    })
  }
}

async function startTemplateDraft(
  ctx: OperatorContext & { eventKey: string; templateId: string }
) {
  const prepared = await prepareZhoraInvocation(ctx)
  if (!prepared) return
  try {
    const draft = await requestTemplateDraft({
      eventKey: ctx.eventKey,
      ticket: prepared.ticket,
      agentId: prepared.agentId,
      fromId: ctx.fromId,
      templateId: ctx.templateId,
    })
    if (draft.ticketId !== prepared.ticket.id)
      throw new ApiError('Это действие относится к другому тикету.', 409)
    await showDraftPreview(ctx, draft)
  } catch (error) {
    await note(
      ctx,
      error instanceof ApiError
        ? error.message
        : 'Не удалось подготовить шаблон. Попробуйте позже.'
    )
  }
}

export async function selectTemplate(
  ctx: OperatorContext & { eventKey: string; templateId: string }
) {
  await startTemplateDraft(ctx)
}

export async function handleTemplateCommand(
  ctx: OperatorContext & {
    eventKey: string
    args: string
    replyToMessageId?: number
  }
) {
  const args = ctx.args.trim()
  if (!args) return showTemplateCategories(ctx)
  if (ctx.replyToMessageId) {
    const edit = /^edit\s+([\s\S]+)$/i.exec(args)
    const fill = /^([A-Za-z][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/.exec(args)
    if (edit || fill) {
      const prepared = await prepareZhoraInvocation(ctx)
      if (!prepared) return
      const draft = await prismaSupport.zhoraTemplateDraft.findFirst({
        where: {
          ticketId: prepared.ticket.id,
          previewTgMessageId: ctx.replyToMessageId,
          sentMessageId: null,
        },
        select: { id: true },
      })
      if (!draft) return note(ctx, 'Ответьте на актуальное превью шаблона.')
      try {
        const updated = await updateTemplateDraft({
          id: draft.id,
          ticketId: prepared.ticket.id,
          previewMessageId: ctx.replyToMessageId,
          fromId: ctx.fromId,
          operation: edit
            ? { kind: 'edit', text: edit[1]! }
            : { kind: 'fill', name: fill![1]!, value: fill![2]! },
        })
        await showDraftPreview(ctx, updated)
      } catch (error) {
        await note(
          ctx,
          error instanceof ApiError
            ? error.message
            : 'Не удалось изменить шаблон. Попробуйте позже.'
        )
      }
      return
    }
  }
  const template = await prismaSupport.zhoraTemplate.findUnique({
    where: { code: args },
    select: { id: true },
  })
  if (!template) {
    await note(ctx, 'Шаблон с таким кодом не найден.')
    return
  }
  await startTemplateDraft({ ...ctx, templateId: template.id })
}

export async function sendTemplateDraft(
  ctx: OperatorContext & {
    draftId: string
    version: number
    previewMessageId: number
  }
) {
  const draft = await prismaSupport.zhoraTemplateDraft.findUnique({
    where: { id: ctx.draftId },
    include: draftInclude,
  })
  if (draft?.sentMessageId) {
    await note(ctx, 'Этот шаблон уже отправлен.')
    return
  }
  if (
    !draft ||
    draft.previewVersion !== ctx.version ||
    draft.previewTgMessageId !== ctx.previewMessageId ||
    !draft.text ||
    draft.missing.length ||
    draft.template.revision !== draft.templateRevision ||
    draft.template.updatedAt.getTime() !== draft.templateUpdatedAt.getTime() ||
    !templateLanguageText(
      draft.template,
      draft.language,
      sourceHash(draft.template.textRu)
    )
  )
    return note(ctx, 'Это превью устарело. Вызовите /t снова.')
  const prepared = await prepareZhoraInvocation({
    ...ctx,
    ticketId: draft.ticketId,
  })
  if (!prepared) return
  if (prepared.ticket.detectedLang !== draft.language)
    return note(ctx, 'Язык тикета изменился. Вызовите /t снова.')
  if (
    draft.template.variables.includes('operator_name') &&
    draft.requestedByTgUserId !== BigInt(ctx.fromId)
  )
    return note(
      ctx,
      'Этот шаблон содержит имя оператора. Вызовите /t самостоятельно.'
    )
  if (draft.template.variables.includes('operator_name') && prepared.agentId) {
    const operator = await prismaSupport.supportAgent.findUnique({
      where: { id: prepared.agentId },
      select: { displayName: true },
    })
    const previewName = (draft.values as Record<string, string>).operator_name
    if (!operator || operator.displayName.trim() !== previewName)
      return note(ctx, 'Имя оператора изменилось. Вызовите /t снова.')
  }
  const claimed = await prismaSupport.zhoraTemplateDraft.updateMany({
    where: {
      id: draft.id,
      sentByTgUserId: null,
      sentMessageId: null,
      previewVersion: ctx.version,
      previewTgMessageId: ctx.previewMessageId,
    },
    data: { sentByTgUserId: BigInt(ctx.fromId) },
  })
  if (!claimed.count && draft.sentByTgUserId !== BigInt(ctx.fromId))
    return note(ctx, 'Этот черновик уже отправляет другой оператор.')
  const dedupeKey = `zhora:template:send:${draft.id}`
  let closed = false
  try {
    const sent = await agentSendMessage({
      ticket: prepared.ticket,
      agentId: prepared.agentId,
      text: draft.text,
      tgMessageId: draft.previewTgMessageId!,
      dedupeKey,
    })
    closed = sent === 'closed'
  } catch {
    logger.warn('[zhora] template delivery status uncertain')
  }
  const message = await prismaSupport.supportMessage.findUnique({
    where: { dedupeKey },
    select: { id: true, agentId: true },
  })
  if (!message) {
    await note(
      ctx,
      closed
        ? 'Тикет закрыт. Шаблон не отправлен.'
        : 'Не удалось подтвердить отправку. Проверьте переписку и повторите нажатие: дубль не будет создан.'
    )
    return
  }
  await prismaSupport.$transaction(async (tx) => {
    await tx.zhoraTemplateDraft.update({
      where: { id: draft.id },
      data: { sentMessageId: message.id },
    })
    await tx.zhoraTemplateUsage.upsert({
      where: { draftId: draft.id },
      create: {
        draftId: draft.id,
        templateId: draft.templateId,
        templateCode: draft.template.code,
        ticketId: draft.ticketId,
        agentId: message.agentId,
        operatorTgUserId: BigInt(ctx.fromId),
        editedBeforeSend: draft.editedBeforeSend,
      },
      update: {},
    })
  })
  await note(ctx, 'Шаблон отправлен клиенту.')
}

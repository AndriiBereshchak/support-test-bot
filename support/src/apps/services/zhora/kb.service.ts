import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma-support'
import { prismaSupport } from '@config/database'
import { ApiError } from '@core/errors/api-error'
import { enqueueKbEmbeddings } from './kb-search.service'
import {
  saveImportedZhoraKbConfig,
  type ZhoraKbConfigInput,
} from './kb-config.service'

export interface ZhoraKbInput {
  question: string
  variants?: string[]
  answer_ru: string
  translations?: Record<string, string>
  category: string
  notes?: string[]
  dynamic_fields?: string[]
  ask_user?: string[]
  is_temporary?: boolean
  domains?: string[]
  status?: 'draft' | 'active'
}

export interface ZhoraKbQuery {
  limit?: number
  offset?: number
  status?: 'draft' | 'active'
  category?: string
}

// Keep internal index metadata out of the KB management response.
const entrySelect = {
  id: true,
  question: true,
  variants: true,
  answer_ru: true,
  translations: true,
  category: true,
  notes: true,
  dynamic_fields: true,
  ask_user: true,
  is_temporary: true,
  domains: true,
  status: true,
  updatedById: true,
  createdAt: true,
  updatedAt: true,
} as const

function entryData(input: Partial<ZhoraKbInput>) {
  return {
    ...(input.question !== undefined && { question: input.question.trim() }),
    ...(input.variants !== undefined && {
      variants: input.variants.map((variant) => variant.trim()),
    }),
    ...(input.answer_ru !== undefined && { answer_ru: input.answer_ru.trim() }),
    ...(input.translations !== undefined && {
      translations: Object.fromEntries(
        Object.entries(input.translations).map(([language, text]) => [
          language,
          text.trim(),
        ])
      ),
    }),
    ...(input.category !== undefined && { category: input.category.trim() }),
    ...(input.notes !== undefined && {
      notes: input.notes.map((text) => text.trim()),
    }),
    ...(input.dynamic_fields !== undefined && {
      dynamic_fields: input.dynamic_fields.map((text) => text.trim()),
    }),
    ...(input.ask_user !== undefined && {
      ask_user: input.ask_user.map((text) => text.trim()),
    }),
    ...(input.is_temporary !== undefined && {
      is_temporary: input.is_temporary,
    }),
    ...(input.domains !== undefined && {
      domains: [
        ...new Set(input.domains.map((domain) => domain.toLowerCase())),
      ],
    }),
    ...(input.status !== undefined && { status: input.status }),
  }
}

function createData(input: ZhoraKbInput, authorId: string) {
  const data = entryData(input)
  return {
    ...data,
    id: randomUUID(),
    question: input.question.trim(),
    answer_ru: input.answer_ru.trim(),
    category: input.category.trim(),
    translations: data.translations ?? {},
    updatedById: authorId,
  }
}

export async function createZhoraKbEntry(
  input: ZhoraKbInput,
  authorId: string
) {
  return prismaSupport.$transaction(async (tx) => {
    const entry = await tx.zhoraKbEntry.create({
      data: createData(input, authorId),
      select: entrySelect,
    })
    if (entry.status === 'active') await enqueueKbEmbeddings([entry.id], tx)
    return entry
  })
}

export async function importZhoraKbEntries(
  entries: ZhoraKbInput[],
  authorId: string,
  config?: ZhoraKbConfigInput
) {
  // Allocate IDs before the bulk insert so the queue targets this import only.
  const data = entries.map((entry) => createData(entry, authorId))
  return prismaSupport.$transaction(async (tx) => {
    if (config) await saveImportedZhoraKbConfig(tx, config, authorId)
    const result = await tx.zhoraKbEntry.createMany({ data })
    await enqueueKbEmbeddings(
      data
        .filter((entry) => entry.status === 'active')
        .map((entry) => entry.id),
      tx
    )
    return { created: result.count }
  })
}

export async function listZhoraKbEntries(query: ZhoraKbQuery) {
  const limit = query.limit ?? 50
  const offset = query.offset ?? 0
  const where: Prisma.ZhoraKbEntryWhereInput = {
    ...(query.status !== undefined && { status: query.status }),
    ...(query.category !== undefined && { category: query.category.trim() }),
  }
  const [items, total] = await prismaSupport.$transaction([
    prismaSupport.zhoraKbEntry.findMany({
      select: entrySelect,
      where,
      take: limit,
      skip: offset,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
    prismaSupport.zhoraKbEntry.count({ where }),
  ])
  return { items, total, limit, offset }
}

export async function getZhoraKbEntry(id: string) {
  const entry = await prismaSupport.zhoraKbEntry.findUnique({
    where: { id },
    select: entrySelect,
  })
  if (!entry) throw new ApiError('KB entry not found', 404, 'KB_NOT_FOUND')
  return entry
}

async function withNotFound<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2025'
    ) {
      throw new ApiError('KB entry not found', 404, 'KB_NOT_FOUND')
    }
    throw error
  }
}

export async function updateZhoraKbEntry(
  id: string,
  input: Partial<ZhoraKbInput>,
  authorId: string
) {
  return withNotFound(() =>
    prismaSupport.$transaction(async (tx) => {
      const entry = await tx.zhoraKbEntry.update({
        select: entrySelect,
        where: { id },
        data: { ...entryData(input), updatedById: authorId },
      })
      if (
        entry.status === 'active' &&
        (input.question !== undefined ||
          input.variants !== undefined ||
          input.answer_ru !== undefined ||
          input.status === 'active')
      ) {
        await enqueueKbEmbeddings([id], tx)
      }
      return entry
    })
  )
}

export async function deleteZhoraKbEntry(id: string): Promise<void> {
  await withNotFound(() => prismaSupport.zhoraKbEntry.delete({ where: { id } }))
}

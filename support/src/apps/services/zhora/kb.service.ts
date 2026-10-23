import { Prisma } from '@prisma-support'
import { prismaSupport } from '@config/database'
import { ApiError } from '@core/errors/api-error'

export interface ZhoraKbInput {
  questions: string[]
  answerRu: string
  translations?: Record<string, string>
  tag: string
  domains?: string[]
  status?: 'draft' | 'active'
}

export interface ZhoraKbQuery {
  limit?: number
  offset?: number
  status?: 'draft' | 'active'
  tag?: string
}

// HTTP validation happens in kb.routes. These functions are internal; the
// authenticated route supplies the author, never a field from the editor body.
function entryData(input: Partial<ZhoraKbInput>) {
  return {
    ...(input.questions !== undefined && {
      questions: input.questions.map((question) => question.trim()),
    }),
    ...(input.answerRu !== undefined && { answerRu: input.answerRu.trim() }),
    ...(input.translations !== undefined && {
      translations: Object.fromEntries(
        Object.entries(input.translations).map(([language, text]) => [
          language,
          text.trim(),
        ])
      ),
    }),
    ...(input.tag !== undefined && { tag: input.tag.trim() }),
    ...(input.domains !== undefined && {
      domains: [
        ...new Set(input.domains.map((domain) => domain.toLowerCase())),
      ],
    }),
    ...(input.status !== undefined && { status: input.status }),
  }
}

export async function createZhoraKbEntry(
  input: ZhoraKbInput,
  authorId: string
) {
  const data = entryData(input)
  return prismaSupport.zhoraKbEntry.create({
    data: {
      ...data,
      questions: input.questions.map((question) => question.trim()),
      answerRu: input.answerRu.trim(),
      tag: input.tag.trim(),
      translations: data.translations ?? {},
      updatedById: authorId,
    },
  })
}

export async function listZhoraKbEntries(query: ZhoraKbQuery) {
  const limit = query.limit ?? 50
  const offset = query.offset ?? 0
  const where: Prisma.ZhoraKbEntryWhereInput = {
    ...(query.status !== undefined && { status: query.status }),
    ...(query.tag !== undefined && { tag: query.tag.trim() }),
  }
  const [items, total] = await prismaSupport.$transaction([
    prismaSupport.zhoraKbEntry.findMany({
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
  const entry = await prismaSupport.zhoraKbEntry.findUnique({ where: { id } })
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
    prismaSupport.zhoraKbEntry.update({
      where: { id },
      data: { ...entryData(input), updatedById: authorId },
    })
  )
}

export async function deleteZhoraKbEntry(id: string): Promise<void> {
  await withNotFound(() => prismaSupport.zhoraKbEntry.delete({ where: { id } }))
}

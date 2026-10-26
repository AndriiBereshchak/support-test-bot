import { Prisma } from '@prisma-support'
import { prismaSupport } from '@config/database'
import { ApiError } from '@core/errors/api-error'

export interface ZhoraKbConfigInput {
  full_version_url: string
  ios_url: string
  android_url: string
}

const configSelect = {
  fullVersionUrl: true,
  iosUrl: true,
  androidUrl: true,
  updatedById: true,
  updatedAt: true,
} as const

function checkedUrl(key: keyof ZhoraKbConfigInput, raw: string) {
  const value = raw?.trim()
  let url: URL
  try {
    url = new URL(value ?? '')
  } catch {
    throw new ApiError(`${key} must be an HTTPS URL`, 400, 'KB_CONFIG_INVALID')
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new ApiError(`${key} must be an HTTPS URL`, 400, 'KB_CONFIG_INVALID')
  }
  return value
}

function checkedUrls(input: Partial<ZhoraKbConfigInput>) {
  return {
    ...(input.full_version_url !== undefined && {
      fullVersionUrl: checkedUrl('full_version_url', input.full_version_url),
    }),
    ...(input.ios_url !== undefined && {
      iosUrl: checkedUrl('ios_url', input.ios_url),
    }),
    ...(input.android_url !== undefined && {
      androidUrl: checkedUrl('android_url', input.android_url),
    }),
  }
}

export async function getZhoraKbConfig() {
  const row = await prismaSupport.zhoraKbConfig.findUnique({
    where: { id: 1 },
    select: configSelect,
  })
  return row && publicConfig(row)
}

function publicConfig(row: {
  fullVersionUrl: string
  iosUrl: string
  androidUrl: string
  updatedById: string
  updatedAt: Date
}) {
  return {
    full_version_url: row.fullVersionUrl,
    ios_url: row.iosUrl,
    android_url: row.androidUrl,
    updatedById: row.updatedById,
    updatedAt: row.updatedAt,
  }
}

export async function saveImportedZhoraKbConfig(
  tx: Prisma.TransactionClient,
  input: ZhoraKbConfigInput,
  authorId: string
) {
  const urls = {
    fullVersionUrl: checkedUrl('full_version_url', input.full_version_url),
    iosUrl: checkedUrl('ios_url', input.ios_url),
    androidUrl: checkedUrl('android_url', input.android_url),
  }
  await tx.zhoraKbConfig.upsert({
    where: { id: 1 },
    create: { id: 1, ...urls, updatedById: authorId },
    // Import seeds the links once; a later import must not undo a URL changed
    // through the dedicated config endpoint.
    update: {},
  })
}

export async function updateZhoraKbConfig(
  input: Partial<ZhoraKbConfigInput>,
  authorId: string
) {
  const urls = checkedUrls(input)
  try {
    const row = await prismaSupport.zhoraKbConfig.update({
      where: { id: 1 },
      data: { ...urls, updatedById: authorId },
      select: configSelect,
    })
    return publicConfig(row)
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2025'
    ) {
      throw new ApiError('KB config not found', 404, 'KB_CONFIG_NOT_FOUND')
    }
    throw error
  }
}

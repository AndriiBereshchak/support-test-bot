import { randomInt } from 'node:crypto'
import * as actual from '../../../src/telegram/api'

export * from '../../../src/telegram/api'

let topicId = randomInt(1000, 1_000_000_000)
let messageId = randomInt(1000, 1_000_000_000)
const events: { operation: string; data: unknown; at: string }[] = []

function record(operation: string, data: unknown): number {
  events.push({
    operation,
    data: JSON.parse(
      JSON.stringify(data, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value
      )
    ),
    at: new Date().toISOString(),
  })
  if (events.length > 200) events.shift()
  return ++messageId
}

export const getDevEvents = () => [...events]
export const createTicketTopic = async (
  input: Parameters<typeof actual.createTicketTopic>[0]
) => {
  const binding = {
    chatId: Number(process.env.SUPPORT_CHAT_ID),
    topicId: ++topicId,
    infoMessageId: record('createTicketTopic', input),
  }
  record('topicBinding', binding)
  return binding
}
export const postTicketCard = async (
  input: Parameters<typeof actual.postTicketCard>[0]
) => record('postTicketCard', input)
export const relayUserMessage = async (
  input: Parameters<typeof actual.relayUserMessage>[0]
) => record('relayUserMessage', input)
export const sendToTopic = async (
  input: Parameters<typeof actual.sendToTopic>[0]
) => record('sendToTopic', input)
export const sendPlainMessage = async (
  input: Parameters<typeof actual.sendPlainMessage>[0]
) => record('sendPlainMessage', input)
export const editTopicMessage = async (
  input: Parameters<typeof actual.editTopicMessage>[0]
) => {
  record('editTopicMessage', input)
}
export const sendTypingToTopic = async (
  ...input: Parameters<typeof actual.sendTypingToTopic>
) => {
  record('sendTypingToTopic', input)
}
export const answerCallback = async (
  ...input: Parameters<typeof actual.answerCallback>
) => {
  record('answerCallback', input)
}
export const closeTicketTopic = async (
  ...input: Parameters<typeof actual.closeTicketTopic>
) => {
  record('closeTicketTopic', input)
}
export const deleteTopicMessage = async (
  ...input: Parameters<typeof actual.deleteTopicMessage>
) => {
  record('deleteTopicMessage', input)
}
export const downloadFile = async () => null
export const getBot = () => null
export const ensureBotInitialized = async () => null
export const registerWebhook = async () => undefined

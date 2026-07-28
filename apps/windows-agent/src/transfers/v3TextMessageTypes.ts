export const V3_TEXT_MESSAGE_MAX_BYTES = 1_500
export const V3_TEXT_MESSAGE_PAGE_LIMIT = 100

export type V3TextMessage = {
  content: string
  contentBytes: number
  createdAt: number
  messageId: string
  recipientDeviceId: string
  senderDeviceId: string
  sequence: number
}

export type V3TextMessagePage = {
  messages: V3TextMessage[]
  nextAfter: number
}

import type {V3TrustedDeviceAccess} from './v3TrustedDeviceAccess'
import {V3TransportError} from './v3TransportError'
import {V3TextMessageStore} from './v3TextMessageStore'
import {V3_TEXT_MESSAGE_MAX_BYTES, V3_TEXT_MESSAGE_PAGE_LIMIT, type V3TextMessage, type V3TextMessagePage} from './v3TextMessageTypes'

export type V3TextMessageChangePublisher = {
  publish: (event: {payload: V3TextMessage; type: 'message.changed'}) => unknown
}

export class V3TextMessageService {
  constructor(
    private readonly trustedDeviceAccess: V3TrustedDeviceAccess,
    private readonly getAgentDeviceId: () => string | null,
    private readonly store = new V3TextMessageStore(),
    private readonly changePublisher?: V3TextMessageChangePublisher
  ) {}

  async close() {
    await this.store.close()
  }

  async receiveFromDevice(value: unknown, sourceDeviceId: string): Promise<V3TextMessage> {
    await this.assertDeviceMaySend(sourceDeviceId)
    const {content, messageId, recipientDeviceId} = validateMessageInput(value)
    const agentDeviceId = this.agentDeviceId()
    if (recipientDeviceId !== agentDeviceId) throw new V3TransportError('TEXT_RECIPIENT_UNAVAILABLE', 400)
    const message = await this.store.append({content, messageId, recipientDeviceId, senderDeviceId: sourceDeviceId})
    this.changePublisher?.publish({payload: message, type: 'message.changed'})
    return message
  }

  async sendFromAgent(value: unknown): Promise<V3TextMessage> {
    const {content, messageId, recipientDeviceId} = validateMessageInput(value)
    await this.assertDeviceMayReceive(recipientDeviceId)
    const message = await this.store.append({content, messageId, recipientDeviceId, senderDeviceId: this.agentDeviceId()})
    this.changePublisher?.publish({payload: message, type: 'message.changed'})
    return message
  }

  async listConversation(peerDeviceId: string): Promise<V3TextMessage[]> {
    await this.assertDeviceExists(peerDeviceId)
    return this.store.listConversation(this.agentDeviceId(), peerDeviceId, 200)
  }

  async listForDevice(deviceId: string, after: number, limit: number): Promise<V3TextMessagePage> {
    await this.assertDeviceExists(deviceId)
    return this.store.listForRecipient(deviceId, after, limit)
  }

  private agentDeviceId() {
    const deviceId = this.getAgentDeviceId()
    if (!deviceId) throw new V3TransportError('TEXT_SERVICE_UNAVAILABLE', 503)
    return deviceId
  }

  private async assertDeviceExists(deviceId: string) {
    try {
      const device = await this.trustedDeviceAccess.get(deviceId)
      if (!device) throw new V3TransportError('DEVICE_NOT_PAIRED', 403)
      return device
    } catch (error) {
      if (error instanceof V3TransportError) throw error
      throw new V3TransportError('TRANSFER_AUTHORIZATION_UNAVAILABLE', 503)
    }
  }

  private async assertDeviceMaySend(deviceId: string) {
    const device = await this.assertDeviceExists(deviceId)
    if (!device.receiveEnabled) throw new V3TransportError('TRANSFER_RECEIVE_DISABLED', 403)
  }

  private async assertDeviceMayReceive(deviceId: string) {
    await this.assertDeviceExists(deviceId)
  }
}

function validateMessageInput(value: unknown): {content: string; messageId: string; recipientDeviceId: string} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new V3TransportError('INVALID_TEXT_MESSAGE', 400)
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 3 || !['content', 'messageId', 'recipientDeviceId'].every((key) => Object.prototype.hasOwnProperty.call(record, key))) {
    throw new V3TransportError('INVALID_TEXT_MESSAGE', 400)
  }
  const {content, messageId, recipientDeviceId} = record
  if (
    typeof content !== 'string'
    || Buffer.byteLength(content, 'utf8') < 1
    || Buffer.byteLength(content, 'utf8') > V3_TEXT_MESSAGE_MAX_BYTES
    || typeof messageId !== 'string'
    || !isIdentifier(messageId)
    || typeof recipientDeviceId !== 'string'
    || !isIdentifier(recipientDeviceId)
  ) throw new V3TransportError('INVALID_TEXT_MESSAGE', 400)
  return {content, messageId, recipientDeviceId}
}

function isIdentifier(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

export {V3_TEXT_MESSAGE_MAX_BYTES, V3_TEXT_MESSAGE_PAGE_LIMIT}

import {createHash, randomUUID} from 'node:crypto'
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'


export type LocalFileDemoDirection = 'receive' | 'send'

export type LocalFileDemoTransfer = {
  createdAt: number
  direction: LocalFileDemoDirection
  fileName: string
  id: string
  mimeType: string
  sha256: string
  sizeBytes: number
  status: 'received' | 'waiting_for_peer'
}

const MAX_HISTORY = 200

export class LocalFileDemoStore {
  private readonly historyPath: string
  private readonly incomingDirectory: string
  private readonly outgoingDirectory: string
  private transfers: LocalFileDemoTransfer[]

  constructor(rootDirectory = path.join(process.env.LOCALAPPDATA || os.homedir(), 'FlowDrop', 'local-web-demo')) {
    this.historyPath = path.join(rootDirectory, 'history.json')
    this.incomingDirectory = path.join(rootDirectory, 'incoming')
    this.outgoingDirectory = path.join(rootDirectory, 'outgoing')
    mkdirSync(this.incomingDirectory, {recursive: true})
    mkdirSync(this.outgoingDirectory, {recursive: true})
    this.transfers = this.readHistory()
  }

  list(): LocalFileDemoTransfer[] {
    return [...this.transfers]
  }

  save(direction: LocalFileDemoDirection, input: {data: Buffer; fileName: string; mimeType: string}): LocalFileDemoTransfer {
    const id = randomUUID()
    const fileName = sanitizeFileName(input.fileName)
    const transfer: LocalFileDemoTransfer = {
      createdAt: Date.now(),
      direction,
      fileName,
      id,
      mimeType: input.mimeType || 'application/octet-stream',
      sha256: createHash('sha256').update(input.data).digest('hex'),
      sizeBytes: input.data.length,
      status: direction === 'receive' ? 'received' : 'waiting_for_peer'
    }
    const destinationDirectory = direction === 'receive' ? this.incomingDirectory : this.outgoingDirectory
    writeFileSync(path.join(destinationDirectory, `${id}-${fileName}`), input.data, {flag: 'wx'})
    this.transfers = [transfer, ...this.transfers].slice(0, MAX_HISTORY)
    writeFileSync(this.historyPath, JSON.stringify(this.transfers, null, 2), 'utf8')
    return transfer
  }

  private readHistory(): LocalFileDemoTransfer[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.historyPath, 'utf8'))
      return Array.isArray(parsed) ? parsed.filter(isLocalFileDemoTransfer).slice(0, MAX_HISTORY) : []
    } catch {
      return []
    }
  }
}

function sanitizeFileName(value: string) {
  const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim()
  return sanitized.slice(0, 180) || 'unnamed'
}

function isLocalFileDemoTransfer(value: unknown): value is LocalFileDemoTransfer {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    (item.direction === 'receive' || item.direction === 'send') &&
    typeof item.fileName === 'string' &&
    typeof item.id === 'string' &&
    typeof item.mimeType === 'string' &&
    typeof item.sha256 === 'string' &&
    typeof item.sizeBytes === 'number' &&
    typeof item.createdAt === 'number' &&
    (item.status === 'received' || item.status === 'waiting_for_peer')
  )
}

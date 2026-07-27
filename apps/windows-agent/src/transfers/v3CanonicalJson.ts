import {V3TransportError} from './v3TransportError'

export function assertCanonicalJsonBody(rawBody: Buffer, parsedBody: unknown): void {
  const canonicalBody = Buffer.from(canonicalizeJson(parsedBody), 'utf8')
  if (!rawBody.equals(canonicalBody)) {
    throw new V3TransportError('NON_CANONICAL_JSON', 400)
  }
}

// V3 canonical JSON sorts object keys by JavaScript UTF-16 code-unit order.
export function canonicalizeJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new V3TransportError('INVALID_TRANSFER', 400)
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(',')}]`
  if (typeof value !== 'object') throw new V3TransportError('INVALID_TRANSFER', 400)

  const record = value as Record<string, unknown>
  const prototype = Object.getPrototypeOf(record)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new V3TransportError('INVALID_TRANSFER', 400)
  }

  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
    .join(',')}}`
}

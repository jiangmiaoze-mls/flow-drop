export class V3TransportError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number
  ) {
    super(code)
    this.name = 'V3TransportError'
  }
}

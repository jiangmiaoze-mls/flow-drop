import type {
  Device,
  TransferAdmissionDeniedCode,
  TransferAdmissionResponse
} from '@flowdrop/types'

export class TransferAdmissionError extends Error {
  constructor(
    public readonly code: TransferAdmissionDeniedCode | 'TRANSFER_ENDPOINT_UNAVAILABLE'
  ) {
    super(code)
    this.name = 'TransferAdmissionError'
  }
}

export async function requestTransferAdmission(peer: Device, sourceDeviceId: string): Promise<void> {
  if (!peer.controlPort) {
    throw new TransferAdmissionError('TRANSFER_ENDPOINT_UNAVAILABLE')
  }

  const response = await fetch(`http://${peer.ip}:${peer.controlPort}/api/transfers/admission`, {
    body: JSON.stringify({sourceDeviceId}),
    headers: {'content-type': 'application/json'},
    method: 'POST'
  })

  const payload = await readResponse(response)
  if (response.ok && payload?.accepted === true) return

  if (payload?.accepted === false) {
    throw new TransferAdmissionError(payload.code)
  }

  throw new TransferAdmissionError('TRANSFER_ENDPOINT_UNAVAILABLE')
}

async function readResponse(response: Response): Promise<TransferAdmissionResponse | null> {
  try {
    return await response.json() as TransferAdmissionResponse
  } catch {
    return null
  }
}

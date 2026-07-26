import {useCallback, useEffect, useState} from 'react'
import {QRCodeSVG} from 'qrcode.react'

import './App.css'

type TrustedDevice = {
  deviceId: string
  deviceKind: 'desktop' | 'laptop' | 'mobile'
  deviceName: string
  lastKnownAddress?: string
  pairedAt: number
  receiveEnabled: boolean
}

type DiscoveredDevice = {
  address: string
  controlPort?: number
  deviceId: string
  deviceName: string
  lastSeenAt: number
  trustedDevice: TrustedDevice | null
}

type DeviceResponse = {
  devices: DiscoveredDevice[]
  trustedDevices: TrustedDevice[]
}

type PairingSession = {
  code: string
  expiresAt: number
  sessionId: string
}

type PairingApprovalRequest = {
  deviceId: string
  deviceKind: 'desktop' | 'laptop' | 'mobile'
  deviceName: string
  requestedAt: number
  requestId: string
}

type PairingRequestsResponse = {
  requests: PairingApprovalRequest[]
}

async function getDevices(): Promise<DeviceResponse> {
  const response = await fetch('/api/devices')
  if (!response.ok) throw new Error('Unable to load devices.')
  return response.json() as Promise<DeviceResponse>
}

async function getPairingRequests(): Promise<PairingRequestsResponse> {
  const response = await fetch('/api/pairing/requests')
  if (!response.ok) throw new Error('Unable to load pairing requests.')
  return response.json() as Promise<PairingRequestsResponse>
}

export default function App() {
  const [data, setData] = useState<DeviceResponse>({devices: [], trustedDevices: []})
  const [error, setError] = useState<string | null>(null)
  const [isDecidingPairing, setIsDecidingPairing] = useState(false)
  const [isCreatingSession, setIsCreatingSession] = useState(false)
  const [updatingDeviceId, setUpdatingDeviceId] = useState<string | null>(null)
  const [session, setSession] = useState<PairingSession | null>(null)
  const [pendingPairingRequests, setPendingPairingRequests] = useState<PairingApprovalRequest[]>([])

  const refresh = useCallback(async () => {
    try {
      const [nextData, nextRequests] = await Promise.all([getDevices(), getPairingRequests()])
      setData(nextData)
      setPendingPairingRequests(nextRequests.requests)
      setError(null)
    } catch {
      setError('无法连接 Windows Agent，请确认 Agent 正在监听 3000 端口。')
    }
  }, [])

  useEffect(() => {
    void refresh()
    const eventSource = new EventSource('/api/admin/events')
    const handleAgentEvent = () => void refresh()

    eventSource.addEventListener('device.changed', handleAgentEvent)
    eventSource.addEventListener('pairing.requested', handleAgentEvent)
    eventSource.addEventListener('pairing.resolved', handleAgentEvent)
    eventSource.addEventListener('permission.changed', handleAgentEvent)

    return () => eventSource.close()
  }, [refresh])

  const createSession = useCallback(async () => {
    setIsCreatingSession(true)
    try {
      const response = await fetch('/api/pairing/sessions', {method: 'POST'})
      if (!response.ok) throw new Error('Unable to create pairing session.')
      const payload = await response.json() as {session: PairingSession}
      setSession(payload.session)
      setError(null)
    } catch {
      setError('配对码生成失败。')
    } finally {
      setIsCreatingSession(false)
    }
  }, [])

  const updateReceivePermission = useCallback(async (deviceId: string, receiveEnabled: boolean) => {
    setUpdatingDeviceId(deviceId)
    try {
      const response = await fetch(`/api/paired-devices/${encodeURIComponent(deviceId)}/receive-permission`, {
        body: JSON.stringify({receiveEnabled}),
        headers: {'content-type': 'application/json'},
        method: 'PATCH'
      })
      if (!response.ok) throw new Error('Unable to update receive permission.')

      await refresh()
      setError(null)
    } catch {
      setError('更新接收许可失败。')
    } finally {
      setUpdatingDeviceId(null)
    }
  }, [refresh])

  const decidePairingRequest = useCallback(async (
    request: PairingApprovalRequest,
    decision: 'approve' | 'reject'
  ) => {
    setIsDecidingPairing(true)
    try {
      const response = await fetch(`/api/pairing/requests/${encodeURIComponent(request.requestId)}/${decision}`, {
        method: 'POST'
      })
      if (!response.ok) throw new Error('Unable to decide pairing request.')

      await refresh()
    } catch {
      setError('处理配对请求失败。')
    } finally {
      setIsDecidingPairing(false)
    }
  }, [refresh])

  const initiateMobilePairing = useCallback(async (deviceId: string) => {
    const code = window.prompt('输入手机“我的设备”中显示的六位配对码')?.trim()
    if (!code) return

    try {
      const response = await fetch(`/api/discovered-devices/${encodeURIComponent(deviceId)}/pair`, {
        body: JSON.stringify({code}),
        headers: {'content-type': 'application/json'},
        method: 'POST'
      })
      if (!response.ok) {
        const payload = await response.json() as {message?: string}
        throw new Error(payload.message)
      }
      await refresh()
      setError(null)
    } catch (error) {
      setError(error instanceof Error ? error.message : '无法向手机发起配对。')
    }
  }, [refresh])

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <h1>FlowDrop Agent</h1>
          <p>本地设备发现与配对演示</p>
        </div>
        <button type="button" onClick={() => void refresh()}>刷新</button>
      </header>

      {error ? <p className="error" role="alert">{error}</p> : null}

      {pendingPairingRequests.map((request) => (
        <div className="pairing-approval-backdrop" key={request.requestId} role="presentation">
          <section
            aria-describedby={`pairing-request-description-${request.requestId}`}
            aria-labelledby={`pairing-request-title-${request.requestId}`}
            aria-modal="true"
            className="pairing-approval-dialog"
            role="dialog">
            <h2 id={`pairing-request-title-${request.requestId}`}>新的配对请求</h2>
            <p id={`pairing-request-description-${request.requestId}`}>
              {request.deviceName} 想与此电脑配对。
            </p>
            <small>{request.deviceKind === 'mobile' ? '手机设备' : '电脑设备'} · {request.deviceId}</small>
            <div className="pairing-approval-actions">
              <button
                disabled={isDecidingPairing}
                onClick={() => void decidePairingRequest(request, 'reject')}
                type="button">
                拒绝
              </button>
              <button
                disabled={isDecidingPairing}
                onClick={() => void decidePairingRequest(request, 'approve')}
                type="button">
                {isDecidingPairing ? '处理中...' : '接受配对'}
              </button>
            </div>
          </section>
        </div>
      ))}

      <section className="pairing-panel" aria-labelledby="pairing-title">
        <div>
          <h2 id="pairing-title">配对码</h2>
          <p>在移动端选择此电脑后输入配对码，再在此确认请求。</p>
        </div>
        <button disabled={isCreatingSession} onClick={() => void createSession()} type="button">
          {isCreatingSession ? '生成中' : '生成配对码'}
        </button>
        {session ? (
          <div className="code" aria-live="polite">
            <strong>{session.code}</strong>
            <span>有效至 {new Date(session.expiresAt).toLocaleTimeString()}</span>
            <div className="qr-code">
              <QRCodeSVG
                bgColor="#ffffff"
                fgColor="#0f4056"
                level="M"
                size={160}
                value={session.code}
              />
            </div>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="discovered-title">
        <div className="section-heading">
          <h2 id="discovered-title">局域网设备</h2>
          <span>{data.devices.length} 台</span>
        </div>
        {data.devices.length === 0 ? <p className="empty">暂未发现设备</p> : (
          <DeviceTable
            devices={data.devices}
            onInitiateMobilePairing={initiateMobilePairing}
            onReceivePermissionChange={updateReceivePermission}
            updatingDeviceId={updatingDeviceId}
          />
        )}
      </section>

      <section aria-labelledby="trusted-title">
        <div className="section-heading">
          <h2 id="trusted-title">已保存的可信设备</h2>
          <span>{data.trustedDevices.length} 台</span>
        </div>
        {data.trustedDevices.length === 0 ? <p className="empty">暂无可信设备</p> : (
          <DeviceTable
            devices={data.trustedDevices.map((device) => ({
            ...device,
            address: device.lastKnownAddress ?? '-',
            lastSeenAt: device.pairedAt,
            trustedDevice: device
            }))}
            onInitiateMobilePairing={initiateMobilePairing}
            onReceivePermissionChange={updateReceivePermission}
            updatingDeviceId={updatingDeviceId}
          />
        )}
      </section>
    </main>
  )
}

function DeviceTable({
  devices,
  onInitiateMobilePairing,
  onReceivePermissionChange,
  updatingDeviceId
}: {
  devices: DiscoveredDevice[]
  onInitiateMobilePairing: (deviceId: string) => Promise<void>
  onReceivePermissionChange: (deviceId: string, receiveEnabled: boolean) => Promise<void>
  updatingDeviceId: string | null
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>设备</th>
            <th>地址</th>
            <th>状态</th>
            <th>接收传输</th>
            <th>配对</th>
            <th>最后活动</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => (
            <tr key={device.deviceId}>
              <td>
                <strong>{device.deviceName}</strong>
                <small>{device.deviceId}</small>
              </td>
              <td>
                {!device.trustedDevice ? (
                  <button onClick={() => void onInitiateMobilePairing(device.deviceId)} type="button">输入手机配对码</button>
                ) : '-'}
              </td>
              <td>{device.address}</td>
              <td>{device.trustedDevice ? '已配对' : '待配对'}</td>
              <td>
                {device.trustedDevice ? (
                  <button
                    disabled={updatingDeviceId === device.deviceId}
                    onClick={() => void onReceivePermissionChange(
                      device.deviceId,
                      !device.trustedDevice?.receiveEnabled
                    )}
                    type="button">
                    {device.trustedDevice.receiveEnabled ? '允许' : '已禁止'}
                  </button>
                ) : '-'}
              </td>
              <td>{new Date(device.lastSeenAt).toLocaleTimeString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

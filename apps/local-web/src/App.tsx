import {useCallback, useEffect, useRef, useState, type ChangeEvent} from 'react'
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

type LocalFileDemoDirection = 'receive' | 'send'

type LocalFileDemoTransfer = {
  createdAt: number
  direction: LocalFileDemoDirection
  fileName: string
  id: string
  mimeType: string
  sha256: string
  sizeBytes: number
  status: 'received' | 'waiting_for_peer'
}

type PeerTransfer = {
  createdAt: number
  failureCode?: string
  items: Array<{itemId: string; kind: 'file' | 'text'; name: string; receivedBytes: number; sizeBytes: number}>
  peerDeviceId: string
  status: 'cancelled' | 'completed' | 'failed' | 'negotiating' | 'transferring' | 'verifying'
  totalBytes: number
  transferredBytes: number
  transferId: string
  updatedAt: number
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

async function getLocalFileDemoTransfers(): Promise<LocalFileDemoTransfer[]> {
  const response = await fetch('/api/file-demo/transfers')
  if (!response.ok) throw new Error('Unable to load local file demo transfers.')
  const payload = await response.json() as {transfers: LocalFileDemoTransfer[]}
  return payload.transfers
}

async function getPeerTransfers(): Promise<PeerTransfer[]> {
  const response = await fetch('/api/transfers')
  if (!response.ok) throw new Error('Unable to load peer transfers.')
  const payload = await response.json() as {transfers: PeerTransfer[]}
  return payload.transfers
}

export default function App() {
  const isMounted = useRef(true)
  const [data, setData] = useState<DeviceResponse>({devices: [], trustedDevices: []})
  const [error, setError] = useState<string | null>(null)
  const [fileDemoTransfers, setFileDemoTransfers] = useState<LocalFileDemoTransfer[]>([])
  const [peerTransfers, setPeerTransfers] = useState<PeerTransfer[]>([])
  const [transferNotice, setTransferNotice] = useState<string | null>(null)
  const [isDecidingPairing, setIsDecidingPairing] = useState(false)
  const [isCreatingSession, setIsCreatingSession] = useState(false)
  const [isUploadingDirection, setIsUploadingDirection] = useState<LocalFileDemoDirection | null>(null)
  const [updatingDeviceId, setUpdatingDeviceId] = useState<string | null>(null)
  const [session, setSession] = useState<PairingSession | null>(null)
  const [pendingPairingRequests, setPendingPairingRequests] = useState<PairingApprovalRequest[]>([])

  const refresh = useCallback(async () => {
    try {
      const [nextData, nextRequests, nextFileDemoTransfers, nextPeerTransfers] = await Promise.all([
        getDevices(),
        getPairingRequests(),
        getLocalFileDemoTransfers(),
        getPeerTransfers()
      ])
      if (!isMounted.current) return
      setData(nextData)
      setFileDemoTransfers(nextFileDemoTransfers)
      setPeerTransfers(nextPeerTransfers)
      setPendingPairingRequests(nextRequests.requests)
      setError(null)
    } catch {
      if (isMounted.current) setError('无法连接 Windows Agent，请确认本机 Agent 正在运行。')
    }
  }, [])

  useEffect(() => {
    isMounted.current = true
    void refresh()
    const eventSource = new EventSource('/api/admin/events')
    const handleAgentEvent = () => void refresh()
    const handleTransferEvent = (event: Event) => {
      const agentEvent = event as MessageEvent<string>
      try {
        const payload = JSON.parse(agentEvent.data) as {payload?: {code?: unknown; status?: unknown}}
        if (payload.payload?.status === 'rejected' && typeof payload.payload.code === 'string') {
          setTransferNotice(getTransferRejectionMessage(payload.payload.code))
        } else {
          setTransferNotice(null)
        }
      } catch {
        setTransferNotice('收到无法解析的传输状态事件。')
      }
      void refresh()
    }

    eventSource.addEventListener('device.changed', handleAgentEvent)
    eventSource.addEventListener('file-demo.changed', handleAgentEvent)
    eventSource.addEventListener('pairing.requested', handleAgentEvent)
    eventSource.addEventListener('pairing.resolved', handleAgentEvent)
    eventSource.addEventListener('permission.changed', handleAgentEvent)
    eventSource.addEventListener('transfer.changed', handleTransferEvent)

    return () => {
      isMounted.current = false
      eventSource.close()
    }
  }, [refresh])

  const createSession = useCallback(async () => {
    setIsCreatingSession(true)
    try {
      const response = await fetch('/api/pairing/sessions', {method: 'POST'})
      if (!response.ok) throw new Error('Unable to create pairing session.')
      const payload = await response.json() as {session: PairingSession}
      if (!isMounted.current) return
      setSession(payload.session)
      setError(null)
    } catch {
      if (isMounted.current) setError('配对码生成失败。')
    } finally {
      if (isMounted.current) setIsCreatingSession(false)
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
      if (isMounted.current) setError(null)
    } catch {
      if (isMounted.current) setError('更新接收许可失败。')
    } finally {
      if (isMounted.current) setUpdatingDeviceId(null)
    }
  }, [refresh])

  const untrustDevice = useCallback(async (device: TrustedDevice) => {
    const confirmed = window.confirm(
      `将从此电脑删除“${device.deviceName}”的配对记录和传输凭据。对方设备上的记录不会被删除；再次传输前需要重新配对。`
    )
    if (!confirmed) return

    setUpdatingDeviceId(device.deviceId)
    try {
      const response = await fetch(`/api/paired-devices/${encodeURIComponent(device.deviceId)}`, {method: 'DELETE'})
      if (!response.ok) throw new Error('Unable to remove paired device.')

      await refresh()
      if (isMounted.current) setError(null)
    } catch {
      if (isMounted.current) setError('解除信任失败。')
    } finally {
      if (isMounted.current) setUpdatingDeviceId(null)
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
      if (isMounted.current) setError('处理配对请求失败。')
    } finally {
      if (isMounted.current) setIsDecidingPairing(false)
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
      if (isMounted.current) setError(null)
    } catch (error) {
      if (isMounted.current) setError(error instanceof Error ? error.message : '无法向手机发起配对。')
    }
  }, [refresh])

  const uploadFileDemo = useCallback(async (direction: LocalFileDemoDirection, file: File) => {
    if (file.size > 32 * 1024 * 1024) {
      setError('本机文件演示单个文件不能超过 32 MiB。')
      return
    }

    setIsUploadingDirection(direction)
    try {
      const response = await fetch(`/api/file-demo/${direction}`, {
        body: file,
        headers: {
          'content-type': 'application/octet-stream',
          'x-flowdrop-file-mime': encodeURIComponent(file.type || 'application/octet-stream'),
          'x-flowdrop-file-name': encodeURIComponent(file.name)
        },
        method: 'POST'
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as {message?: string} | null
        throw new Error(payload?.message || 'Unable to save the local file demo item.')
      }
      await refresh()
      if (isMounted.current) setError(null)
    } catch (uploadError) {
      if (isMounted.current) setError(uploadError instanceof Error ? uploadError.message : '文件演示操作失败。')
    } finally {
      if (isMounted.current) setIsUploadingDirection(null)
    }
  }, [refresh])

  const handleFileSelection = useCallback((direction: LocalFileDemoDirection, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file) void uploadFileDemo(direction, file)
  }, [uploadFileDemo])

  const receivedFiles = fileDemoTransfers.filter((transfer) => transfer.direction === 'receive')
  const sendingFiles = fileDemoTransfers.filter((transfer) => transfer.direction === 'send')

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <h1>FlowDrop Agent</h1>
          <p>本机局域网发现、配对与文件演示</p>
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
              <button disabled={isDecidingPairing} onClick={() => void decidePairingRequest(request, 'reject')} type="button">拒绝</button>
              <button disabled={isDecidingPairing} onClick={() => void decidePairingRequest(request, 'approve')} type="button">
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
              <QRCodeSVG bgColor="#ffffff" fgColor="#0f4056" level="M" size={160} value={session.code}/>
            </div>
          </div>
        ) : null}
      </section>

      <section className="file-demo-section" aria-labelledby="file-demo-title">
        <div className="section-heading">
          <div>
            <h2 id="file-demo-title">本机文件演示</h2>
            <p className="section-description">接收操作会将文件保存到本机演示目录；发送操作只创建持久化等待队列，当前移动端尚未提供接收端，因此不会显示为已发送。</p>
          </div>
        </div>
        <div className="file-demo-actions">
          <label className={`file-action ${isUploadingDirection === 'receive' ? 'is-busy' : ''}`}>
            <span>接收文件</span>
            <small>导入并保存到本机</small>
            <input disabled={isUploadingDirection !== null} onChange={(event) => handleFileSelection('receive', event)} type="file"/>
          </label>
          <label className={`file-action file-action-secondary ${isUploadingDirection === 'send' ? 'is-busy' : ''}`}>
            <span>发送文件</span>
            <small>创建等待对端的队列</small>
            <input disabled={isUploadingDirection !== null} onChange={(event) => handleFileSelection('send', event)} type="file"/>
          </label>
        </div>
        <div className="file-demo-grid">
          <FileDemoList emptyText="还没有接收的演示文件" title="已接收" transfers={receivedFiles}/>
          <FileDemoList emptyText="还没有待发送文件" title="发送队列" transfers={sendingFiles}/>
        </div>
      </section>

      <section aria-labelledby="peer-transfers-title">
        <div className="section-heading">
          <div>
            <h2 id="peer-transfers-title">来自局域网设备的传输</h2>
            <p className="section-description">仅显示对等传输 API 的真实接收记录，不包含本机文件演示。</p>
          </div>
          <span>{peerTransfers.length} 项</span>
        </div>
        {transferNotice ? <p className="error" role="alert">{transferNotice}</p> : null}
        <PeerTransferList transfers={peerTransfers}/>
      </section>

      <section aria-labelledby="discovered-title">
        <div className="section-heading">
          <h2 id="discovered-title">局域网设备</h2>
          <span>{data.devices.length} 台</span>
        </div>
        {data.devices.length === 0 ? <p className="empty">暂未发现设备</p> : (
          <DeviceTable devices={data.devices} onInitiateMobilePairing={initiateMobilePairing} onReceivePermissionChange={updateReceivePermission} onUntrust={untrustDevice} updatingDeviceId={updatingDeviceId}/>
        )}
      </section>

      <section aria-labelledby="trusted-title">
        <div className="section-heading">
          <h2 id="trusted-title">已保存的可信设备</h2>
          <span>{data.trustedDevices.length} 台</span>
        </div>
        {data.trustedDevices.length === 0 ? <p className="empty">暂无可信设备</p> : (
          <DeviceTable
            devices={data.trustedDevices.map((device) => ({...device, address: device.lastKnownAddress ?? '-', lastSeenAt: device.pairedAt, trustedDevice: device}))}
            onInitiateMobilePairing={initiateMobilePairing}
            onReceivePermissionChange={updateReceivePermission}
            onUntrust={untrustDevice}
            updatingDeviceId={updatingDeviceId}
          />
        )}
      </section>
    </main>
  )
}

function PeerTransferList({transfers}: {transfers: PeerTransfer[]}) {
  if (transfers.length === 0) return <p className="empty">还没有收到对等传输请求</p>
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>内容</th><th>来源设备</th><th>进度</th><th>状态</th><th>更新时间</th></tr></thead>
        <tbody>
          {transfers.map((transfer) => (
            <tr key={transfer.transferId}>
              <td><strong>{transfer.items.map((item) => item.name).join('、')}</strong><small>{transfer.transferId}</small></td>
              <td>{transfer.peerDeviceId}</td>
              <td>{formatBytes(transfer.transferredBytes)} / {formatBytes(transfer.totalBytes)}</td>
              <td><span className={`file-status ${transfer.status}`}>{getTransferStatusLabel(transfer)}</span></td>
              <td>{new Date(transfer.updatedAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function FileDemoList({emptyText, title, transfers}: {emptyText: string; title: string; transfers: LocalFileDemoTransfer[]}) {
  return (
    <section className="file-list" aria-label={title}>
      <div className="section-heading"><h3>{title}</h3><span>{transfers.length} 项</span></div>
      {transfers.length === 0 ? <p className="empty">{emptyText}</p> : (
        <ul>
          {transfers.map((transfer) => (
            <li key={transfer.id}>
              <div>
                <strong>{transfer.fileName}</strong>
                <small>{formatBytes(transfer.sizeBytes)} · {new Date(transfer.createdAt).toLocaleString()}</small>
              </div>
              <span className={`file-status ${transfer.status}`}>{transfer.status === 'received' ? '已接收' : '等待对端'}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function DeviceTable({
  devices,
  onInitiateMobilePairing,
  onReceivePermissionChange,
  onUntrust,
  updatingDeviceId
}: {
  devices: DiscoveredDevice[]
  onInitiateMobilePairing: (deviceId: string) => Promise<void>
  onReceivePermissionChange: (deviceId: string, receiveEnabled: boolean) => Promise<void>
  onUntrust: (device: TrustedDevice) => Promise<void>
  updatingDeviceId: string | null
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>设备</th><th>地址</th><th>状态</th><th>接收传输</th><th>配对</th><th>解除信任</th><th>最后活动</th></tr>
        </thead>
        <tbody>
          {devices.map((device) => (
            <tr key={device.deviceId}>
              <td><strong>{device.deviceName}</strong><small>{device.deviceId}</small></td>
              <td>{device.address}</td>
              <td>{device.trustedDevice ? '已配对' : '待配对'}</td>
              <td>
                {device.trustedDevice ? (
                  <button disabled={updatingDeviceId === device.deviceId} onClick={() => void onReceivePermissionChange(device.deviceId, !device.trustedDevice?.receiveEnabled)} type="button">
                    {device.trustedDevice.receiveEnabled ? '允许' : '已禁止'}
                  </button>
                ) : '-'}
              </td>
              <td>{!device.trustedDevice ? <button onClick={() => void onInitiateMobilePairing(device.deviceId)} type="button">输入手机配对码</button> : '-'}</td>
              <td>{device.trustedDevice ? <button disabled={updatingDeviceId === device.deviceId} onClick={() => void onUntrust(device.trustedDevice!)} type="button">解除</button> : '-'}</td>
              <td>{new Date(device.lastSeenAt).toLocaleTimeString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function formatBytes(sizeBytes: number) {
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KiB`
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MiB`
}

function getTransferRejectionMessage(code: string) {
  if (code === 'AUTHENTICATION_REQUIRED') return '已收到传输请求，但传输凭据无效、缺失或已过期。'
  if (code === 'DEVICE_NOT_PAIRED') return '已收到传输请求，但来源设备未配对。'
  if (code === 'TRANSFER_RECEIVE_DISABLED') return '已收到传输请求，但该来源设备的接收许可已关闭。'
  return `传输请求被拒绝：${code}`
}

function getTransferStatusLabel(transfer: PeerTransfer) {
  if (transfer.status === 'completed') return '已接收'
  if (transfer.status === 'failed') return transfer.failureCode ? `失败：${transfer.failureCode}` : '失败'
  if (transfer.status === 'cancelled') return '已取消'
  if (transfer.status === 'verifying') return '正在校验'
  if (transfer.status === 'transferring') return '接收中'
  return '正在协商'
}

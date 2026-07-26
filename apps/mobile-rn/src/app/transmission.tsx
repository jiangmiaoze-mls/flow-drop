import {useLocalSearchParams, useRouter} from 'expo-router'
import {SymbolView} from 'expo-symbols'
import {useCallback, useEffect, useRef, useState} from 'react'
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native'
import {SafeAreaView} from 'react-native-safe-area-context'

import {Header} from '@/components/Header'
import {BasicAlertDialog} from '@/components/BasicAlertDialog'
import TextDeliveryBottomSheet, {
  type TextDeliveryBottomSheetRef,
} from '@/components/TextDeliveryBottomSheet'
import {PAGE_HORIZONTAL_PADDING} from '@/constants/layout'
import {useTheme} from '@/hooks/use-theme'
import {getDeviceId} from '@/network/discoveryService'
import {requestTransferAdmission, TransferAdmissionError} from '@/network/transferAdmissionClient'
import {
  cancelOutgoingTransfer,
  hashFile,
  hashText,
  pauseOutgoingTransfer,
  resumeOutgoingTransfer,
  sendOutgoingTransfer,
  TransferClientError
} from '@/network/transferClient'
import {getTransferSecret} from '@/storage/transferCredentialRepository'
import {
  createOutgoingTransfer,
  getOutgoingTransfer,
  listOutgoingTransfers,
  replaceOutgoingTransferItems,
  setOutgoingTransferPreparationProgress,
  setOutgoingTransferStatus,
  type OutgoingTransferItem,
  type OutgoingTransferTask
} from '@/storage/outgoingTransferRepository'
import type {Device} from '@flowdrop/types'
import * as Crypto from 'expo-crypto'
import * as DocumentPicker from 'expo-document-picker'
import {Directory, File, Paths} from 'expo-file-system'


type TransmissionParams = {
  controlPort?: string
  id?: string
  ip?: string
  name?: string
  paired?: string
  type?: 'desktop' | 'laptop' | 'mobile'
}

type QueuedFilePreparation = {
  asset: {mimeType?: string | null; name: string; size?: number; uri: string}
  itemId: string
  transferId: string
}

export default function Transmission() {
  const theme = useTheme()
  const router = useRouter()
  const textDeliveryBottomSheetRef = useRef<TextDeliveryBottomSheetRef>(null)
  const activeTransferControllers = useRef(new Map<string, AbortController>())
  const isProcessingQueue = useRef(false)
  const preparingTransferIds = useRef(new Set<string>())
  const isMounted = useRef(false)
  const params = useLocalSearchParams<TransmissionParams>()
  const [outgoingTransfers, setOutgoingTransfers] = useState<OutgoingTransferTask[]>([])
  const [isCheckingPermission, setIsCheckingPermission] = useState(false)
  const [transferError, setTransferError] = useState<string | null>(null)
  const deviceName = params.name || '未知设备'
  const deviceIp = params.ip || '--'
  const isPaired = params.paired === 'true'
  const deviceIcon = params.type === 'desktop'
    ? {ios: 'desktopcomputer' as const, android: 'desktop_windows' as const, web: 'desktop_windows' as const}
    : {ios: 'laptopcomputer' as const, android: 'laptop_mac' as const, web: 'laptop_mac' as const}
  const currentTransfers = outgoingTransfers.filter((task) => task.status !== 'cancelled' && task.status !== 'completed')
  const queueCount = currentTransfers.filter((task) => !isTerminalTransferStatus(task.status)).length

  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])

  const refreshOutgoingTransfers = useCallback(() => {
    if (!params.id || !isMounted.current) return
    const tasks = listOutgoingTransfers(params.id).map((task) => {
      if (isPausableTransferStatus(task.status) && !activeTransferControllers.current.has(task.transferId)) {
        return setOutgoingTransferStatus(task.transferId, 'paused')
      }
      return task
    })
    setOutgoingTransfers(tasks)
  }, [params.id])

  useEffect(() => {
    refreshOutgoingTransfers()
  }, [refreshOutgoingTransfers])

  const handleBack = useCallback(() => {
    router.back()
  }, [router])

  const handleOpenTextDelivery = useCallback(() => {
    textDeliveryBottomSheetRef.current?.present()
  }, [])

  const getTransferPeer = useCallback((): Device | null => {
    const controlPort = Number(params.controlPort)
    if (!params.id || !params.ip || !params.type || !Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65_535) {
      return null
    }
    return {
      controlPort,
      id: params.id,
      ip: params.ip,
      name: deviceName,
      paired: isPaired,
      type: params.type
    }
  }, [deviceName, isPaired, params.controlPort, params.id, params.ip, params.type])

  const verifyTargetAllowsTransfer = useCallback(async (): Promise<Device | null> => {
    const peer = getTransferPeer()
    if (!peer) {
      if (isMounted.current) setTransferError('当前设备未提供可用的传输服务，请返回设备列表后重试。')
      return null
    }

    if (isMounted.current) setIsCheckingPermission(true)
    try {
      await requestTransferAdmission(peer, await getDeviceId())
      return peer
    } catch (error) {
      if (isMounted.current) setTransferError(getTransferErrorMessage(error))
      return null
    } finally {
      if (isMounted.current) setIsCheckingPermission(false)
    }
  }, [getTransferPeer])

  const sendTask = useCallback(async (transferId: string) => {
    const task = listOutgoingTransfers(params.id ?? '').find((candidate) => candidate.transferId === transferId)
    if (!task) return false

    const controller = new AbortController()
    activeTransferControllers.current.set(task.transferId, controller)
    setOutgoingTransferStatus(task.transferId, 'negotiating')
    refreshOutgoingTransfers()
    try {
      const transferSecret = await getTransferSecret(task.peerDeviceId)
      if (!transferSecret) throw new TransferClientError('AUTHENTICATION_REQUIRED')
      await sendOutgoingTransfer(task, await getDeviceId(), transferSecret, (transferredBytes) => {
        if (controller.signal.aborted) return
        setOutgoingTransferStatus(task.transferId, 'transferring', {transferredBytes})
        refreshOutgoingTransfers()
      }, controller.signal)
      if (controller.signal.aborted) throw new TransferClientError('TRANSFER_CANCELLED')
      setOutgoingTransferStatus(task.transferId, 'completed', {transferredBytes: task.totalBytes})
      refreshOutgoingTransfers()
      return true
    } catch (error) {
      if (error instanceof TransferClientError && error.code === 'TRANSFER_CANCELLED') {
        const currentStatus = getOutgoingTransfer(task.transferId)?.status
        if (currentStatus === 'cancelled' || currentStatus === 'paused' || currentStatus === 'queued') return false
        if (activeTransferControllers.current.get(task.transferId) === controller) {
          setOutgoingTransferStatus(task.transferId, 'paused')
          refreshOutgoingTransfers()
        }
        return false
      }
      if (activeTransferControllers.current.get(task.transferId) !== controller) return false
      const failureCode = getTransferFailureCode(error)
      setOutgoingTransferStatus(
        task.transferId,
        failureCode === 'PEER_OFFLINE' || failureCode === 'NETWORK_TIMEOUT' ? 'waiting_for_peer' : 'failed',
        {failureCode}
      )
      refreshOutgoingTransfers()
      if (isMounted.current) setTransferError(getTransferErrorMessage(error))
      return false
    } finally {
      if (activeTransferControllers.current.get(task.transferId) === controller) {
        activeTransferControllers.current.delete(task.transferId)
      }
    }
  }, [params.id, refreshOutgoingTransfers])

  const processTransferQueue = useCallback(async () => {
    if (isProcessingQueue.current || !params.id) return
    isProcessingQueue.current = true
    try {
      while (true) {
        const nextTask = listOutgoingTransfers(params.id).find((task) => task.status !== 'cancelled' && task.status !== 'completed')
        if (!nextTask || nextTask.status !== 'queued') return

        const completed = await sendTask(nextTask.transferId)
        if (!completed) return
      }
    } finally {
      isProcessingQueue.current = false
      if (params.id && listOutgoingTransfers(params.id).some((task) => task.status === 'queued')) {
        void processTransferQueue()
      }
    }
  }, [params.id, sendTask])

  const prepareQueuedFiles = useCallback(async (entries: QueuedFilePreparation[]) => {
    for (const entry of entries) {
      if (preparingTransferIds.current.has(entry.transferId)) continue
      preparingTransferIds.current.add(entry.transferId)
      try {
        const item = await prepareFileItem(entry.asset, entry.itemId, (preparedBytes, totalBytes) => {
          if (getOutgoingTransfer(entry.transferId)?.status !== 'preparing') return
          setOutgoingTransferPreparationProgress(entry.transferId, entry.itemId, totalBytes, preparedBytes)
          refreshOutgoingTransfers()
        })
        if (getOutgoingTransfer(entry.transferId)?.status !== 'preparing') continue
        replaceOutgoingTransferItems(entry.transferId, [item])
        refreshOutgoingTransfers()
        void processTransferQueue()
      } catch (error) {
        if (getOutgoingTransfer(entry.transferId)?.status !== 'preparing') continue
        setOutgoingTransferStatus(entry.transferId, 'failed', {failureCode: getTransferFailureCode(error)})
        refreshOutgoingTransfers()
        if (isMounted.current) setTransferError(getTransferErrorMessage(error))
      } finally {
        preparingTransferIds.current.delete(entry.transferId)
      }
    }
  }, [processTransferQueue, refreshOutgoingTransfers])

  useEffect(() => {
    if (!params.id) return
    const tasks = listOutgoingTransfers(params.id)
    for (const task of tasks) {
      if (task.status === 'queued' && task.items.some(isFilePreparationPlaceholder)) {
        setOutgoingTransferStatus(task.transferId, 'preparing')
      }
    }
    const entries = listOutgoingTransfers(params.id)
      .filter((task) => task.status === 'preparing')
      .flatMap((task) => task.items.flatMap((item) => (
        item.kind === 'file' && item.sourceUri
          ? [{asset: {mimeType: item.mimeType, name: item.name, size: item.sizeBytes, uri: item.sourceUri}, itemId: item.itemId, transferId: task.transferId}]
          : []
      )))
    if (entries.length > 0) void prepareQueuedFiles(entries)
  }, [params.id, prepareQueuedFiles])

  const handleRetryTransfer = useCallback((transferId: string) => {
    setOutgoingTransferStatus(transferId, 'queued')
    refreshOutgoingTransfers()
    void processTransferQueue()
  }, [processTransferQueue, refreshOutgoingTransfers])

  const handlePauseTransfer = useCallback(async (transferId: string) => {
    const task = listOutgoingTransfers(params.id ?? '').find((candidate) => candidate.transferId === transferId)
    if (!task) return

    activeTransferControllers.current.get(transferId)?.abort()
    setOutgoingTransferStatus(task.transferId, 'paused')
    refreshOutgoingTransfers()

    try {
      const transferSecret = await getTransferSecret(task.peerDeviceId)
      if (!transferSecret) throw new TransferClientError('AUTHENTICATION_REQUIRED')
      await pauseOutgoingTransfer(task, await getDeviceId(), transferSecret)
    } catch (error) {
      if (isRemoteTransferMissing(error)) return
      setOutgoingTransferStatus(task.transferId, 'queued')
      refreshOutgoingTransfers()
      if (isMounted.current) setTransferError(getTransferErrorMessage(error))
    }
  }, [params.id, refreshOutgoingTransfers])

  const handleResumeTransfer = useCallback(async (transferId: string) => {
    const task = getOutgoingTransfer(transferId)
    if (!task || task.status !== 'paused') return

    setOutgoingTransferStatus(task.transferId, 'queued')
    refreshOutgoingTransfers()
    try {
      const transferSecret = await getTransferSecret(task.peerDeviceId)
      if (!transferSecret) throw new TransferClientError('AUTHENTICATION_REQUIRED')
      await resumeOutgoingTransfer(task, await getDeviceId(), transferSecret)
      void processTransferQueue()
    } catch (error) {
      if (isRemoteTransferMissing(error)) {
        void processTransferQueue()
        return
      }
      setOutgoingTransferStatus(task.transferId, 'paused')
      refreshOutgoingTransfers()
      if (isMounted.current) setTransferError(getTransferErrorMessage(error))
    }
  }, [processTransferQueue, refreshOutgoingTransfers])

  const handleCancelTransfer = useCallback(async (transferId: string) => {
    const task = getOutgoingTransfer(transferId)
    if (!task || task.status === 'cancelled' || task.status === 'completed') return

    activeTransferControllers.current.get(transferId)?.abort()
    setOutgoingTransferStatus(transferId, 'cancelled')
    refreshOutgoingTransfers()

    try {
      const transferSecret = await getTransferSecret(task.peerDeviceId)
      if (!transferSecret) throw new TransferClientError('AUTHENTICATION_REQUIRED')
      await cancelOutgoingTransfer(task, await getDeviceId(), transferSecret)
    } catch (error) {
      if (isRemoteTransferMissing(error)) return
      setOutgoingTransferStatus(task.transferId, task.status === 'transferring' || task.status === 'negotiating' ? 'queued' : task.status)
      refreshOutgoingTransfers()
      if (isMounted.current) setTransferError(getTransferErrorMessage(error))
    }
  }, [refreshOutgoingTransfers])

  const chooseFile = useCallback(async () => {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: true
    })
    if (result.canceled) return

    const peer = getTransferPeer()
    if (!peer) {
      if (isMounted.current) setTransferError('当前设备未提供可用的传输服务，请返回设备列表后重试。')
      return
    }

    const entries = result.assets.map((asset) => {
      const itemId = Crypto.randomUUID()
      const task = createTask(peer, [createPreparingFileItem(asset, itemId)])
      return {asset, itemId, transferId: task.transferId}
    })
    refreshOutgoingTransfers()
    void prepareQueuedFiles(entries)
  }, [getTransferPeer, prepareQueuedFiles, refreshOutgoingTransfers])

  const handleTextDelivery = useCallback(async (text: string): Promise<boolean> => {
    const peer = await verifyTargetAllowsTransfer()
    if (!peer) return false
    try {
      const hash = hashText(text)
      createTask(peer, [{
        itemId: Crypto.randomUUID(),
        kind: 'text',
        mimeType: 'text/plain; charset=utf-8',
        name: 'FlowDrop text.txt',
        sha256: hash.sha256,
        sizeBytes: hash.sizeBytes,
        status: 'queued',
        text,
        transferredBytes: 0
      }])
      refreshOutgoingTransfers()
      void processTransferQueue()
      return true
    } catch (error) {
      if (isMounted.current) setTransferError(getTransferErrorMessage(error))
      return false
    }
  }, [processTransferQueue, refreshOutgoingTransfers, verifyTargetAllowsTransfer])

  return (
    <SafeAreaView
      edges={['top', 'bottom']}
      style={[styles.screen, {backgroundColor: theme.background}]}>
      <Header>
        <Header.Left>
          <Pressable
            accessibilityLabel="返回"
            accessibilityRole="button"
            hitSlop={12}
            onPress={handleBack}
            style={({pressed}) => [styles.headerButton, pressed && styles.pressed]}>
            <SymbolView
              name={{ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back'}}
              size={25}
              tintColor={theme.text}
            />
          </Pressable>
        </Header.Left>

        <Header.Center>
          <Text numberOfLines={1} style={[styles.headerTitle, {color: theme.text}]}>
            {deviceName}
          </Text>
        </Header.Center>

        <Header.Right/>
      </Header>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}>
        <View
          style={[
            styles.devicePanel,
            {backgroundColor: theme.background, borderColor: theme.backgroundElement}
          ]}>
          <View style={[styles.deviceIcon, {backgroundColor: theme.backgroundElement}]}>
            <SymbolView name={deviceIcon} size={48} tintColor={theme.text}/>
          </View>

          <View style={styles.statusRow}>
            <View style={styles.onlineDot}/>
            <Text style={[styles.statusText, {color: theme.text}]}>在线 / {isPaired ? '已配对' : '未配对'}</Text>
          </View>

          <View style={[styles.ipBadge, {backgroundColor: theme.backgroundElement}]}>
            <Text style={[styles.ipText, {color: theme.text}]}>{deviceIp}</Text>
          </View>
        </View>

        <View style={styles.actionRow}>
          <Pressable
            accessibilityLabel="投递文件"
            accessibilityRole="button"
            accessibilityState={{disabled: isCheckingPermission}}
            disabled={isCheckingPermission}
            style={({pressed}) => [
              styles.actionCard,
              styles.primaryAction,
              pressed && styles.actionPressed
            ]}
            onPress={() => void chooseFile()}
          >
            <SymbolView
              name={{ios: 'doc.badge.arrow.up', android: 'upload_file', web: 'upload_file'}}
              size={42}
              tintColor="#FFFFFF"
            />
            <Text style={styles.primaryActionText}>{isCheckingPermission ? '验证中...' : '投递文件'}</Text>
          </Pressable>

          <Pressable
            accessibilityLabel="投递文字"
            accessibilityRole="button"
            accessibilityState={{disabled: isCheckingPermission}}
            disabled={isCheckingPermission}
            onPress={handleOpenTextDelivery}
            style={({pressed}) => [
              styles.actionCard,
              {backgroundColor: theme.background, borderColor: theme.backgroundElement},
              pressed && styles.actionPressed
            ]}>
            <SymbolView
              name={{ios: 'text.bubble', android: 'chat', web: 'chat'}}
              size={42}
              tintColor={theme.text}
            />
            <Text style={[styles.secondaryActionText, {color: theme.text}]}>{isCheckingPermission ? '验证中...' : '投递文字'}</Text>
          </Pressable>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, {color: theme.text}]}>当前传输</Text>
          <Text style={[styles.queueCount, {color: theme.textSecondary}]}>{queueCount} 项队列</Text>
        </View>

        {currentTransfers.length === 0 ? (
          <Text style={[styles.emptyTransferText, {color: theme.textSecondary}]}>尚无传输任务</Text>
        ) : currentTransfers.map((task) => (
          <View key={task.transferId} style={[styles.transferCard, {backgroundColor: theme.background, borderColor: theme.backgroundElement}]}>
            <View style={styles.transferInfoRow}>
              <View style={[styles.fileIcon, {backgroundColor: theme.backgroundElement}]}>
                <SymbolView
                  name={{ios: task.items[0]?.kind === 'text' ? 'text.bubble.fill' : 'doc.fill', android: task.items[0]?.kind === 'text' ? 'chat' : 'description', web: task.items[0]?.kind === 'text' ? 'chat' : 'description'}}
                  size={27}
                  tintColor={theme.text}
                />
              </View>
              <View style={styles.transferInfo}>
                <Text numberOfLines={1} style={[styles.transferName, {color: theme.text}]}> {task.items[0]?.name ?? '未命名传输'} </Text>
                <Text style={[styles.transferMeta, {color: theme.textSecondary}]}>{formatBytes(task.transferredBytes)} / {formatBytes(task.totalBytes)} · {getTransferStatusLabel(task.status)}</Text>
              </View>
              <View style={styles.transferActions}>
                {task.status === 'failed' ? (
                  <Pressable
                    accessibilityLabel="重发传输"
                    accessibilityRole="button"
                    onPress={() => handleRetryTransfer(task.transferId)}
                    style={({pressed}) => [styles.transferCommandButton, {backgroundColor: theme.backgroundElement}, pressed && styles.pressed]}>
                    <SymbolView name={{ios: 'arrow.clockwise', android: 'refresh', web: 'refresh'}} size={18} tintColor={theme.text}/>
                  </Pressable>
                ) : task.status === 'paused' ? (
                  <Pressable
                    accessibilityLabel="继续传输"
                    accessibilityRole="button"
                    onPress={() => void handleResumeTransfer(task.transferId)}
                    style={({pressed}) => [styles.transferCommandButton, {backgroundColor: theme.backgroundElement}, pressed && styles.pressed]}>
                    <SymbolView name={{ios: 'play.fill', android: 'play_arrow', web: 'play_arrow'}} size={17} tintColor={theme.text}/>
                  </Pressable>
                ) : isPausableTransferStatus(task.status) ? (
                  <Pressable
                    accessibilityLabel="暂停传输"
                    accessibilityRole="button"
                    onPress={() => void handlePauseTransfer(task.transferId)}
                    style={({pressed}) => [styles.transferCommandButton, styles.pauseButton, pressed && styles.pressed]}>
                    <SymbolView name={{ios: 'pause.fill', android: 'pause', web: 'pause'}} size={15} tintColor="#FFFFFF"/>
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityLabel="取消传输"
                  accessibilityRole="button"
                  onPress={() => void handleCancelTransfer(task.transferId)}
                  style={({pressed}) => [styles.cancelButton, pressed && styles.pressed]}>
                  <SymbolView name={{ios: 'xmark', android: 'close', web: 'close'}} size={18} tintColor="#FFFFFF"/>
                </Pressable>
              </View>
            </View>
            <View style={[styles.progressTrack, {backgroundColor: theme.backgroundElement}]}>
              <View style={[styles.progressBar, {width: `${task.totalBytes === 0 ? 0 : task.transferredBytes / task.totalBytes * 100}%`}]}/>
            </View>
          </View>
        ))}
      </ScrollView>

      <TextDeliveryBottomSheet
        ref={textDeliveryBottomSheetRef}
        onSubmit={handleTextDelivery}
        targetName={deviceName}
      />

      <BasicAlertDialog
        message={transferError ?? ''}
        onConfirm={() => setTransferError(null)}
        title="无法投递"
        visible={transferError !== null}
      />
    </SafeAreaView>
  )
}

function getTransferErrorMessage(error: unknown): string {
  if (error instanceof TransferClientError) {
    if (error.code === 'AUTHENTICATION_REQUIRED') {
      return '此设备的配对没有传输凭据，请解除信任后重新配对。'
    }
    if (error.code === 'FILE_CHANGED') {
      return '文件在准备或传输期间发生变化，请重新选择文件。'
    }
    if (error.code === 'TRANSFER_RECEIVE_DISABLED') {
      return '对方当前不接受来自此设备的传输。'
    }
    if (error.code === 'DEVICE_NOT_PAIRED') {
      return '对方未保存此设备的配对关系，请重新配对。'
    }
    if (error.code === 'PEER_OFFLINE') {
      return '无法连接对方设备，任务会保留等待后续重试。'
    }
    if (error.code === 'TRANSFER_PROTOCOL_ERROR' || error.code === 'TRANSFER_ENDPOINT_UNAVAILABLE') {
      return '对方未返回可识别的传输协议响应，请确认电脑端 Agent 已重启并使用最新版本。'
    }
  }
  if (error instanceof TransferAdmissionError) {
    if (error.code === 'TRANSFER_RECEIVE_DISABLED') {
      return '对方当前不接受来自此设备的传输。'
    }
    if (error.code === 'DEVICE_NOT_PAIRED') {
      return '对方未保存此设备的配对关系，请重新配对。'
    }
    return '对方未提供可用的传输服务。'
  }

  return '无法连接对方设备，请确认设备在线且处于同一局域网。'
}

function createTask(peer: Device, items: OutgoingTransferItem[]): OutgoingTransferTask {
  const taskItems = items
  const task = createOutgoingTransfer({
    items: taskItems,
    peerAddress: peer.ip,
    peerControlPort: peer.controlPort ?? 0,
    peerDeviceId: peer.id,
    totalBytes: taskItems.reduce((total, item) => total + item.sizeBytes, 0),
    transferId: Crypto.randomUUID()
  })
  return taskItems.some(isFilePreparationPlaceholder)
    ? setOutgoingTransferStatus(task.transferId, 'preparing')
    : task
}

function isFilePreparationPlaceholder(item: OutgoingTransferItem) {
  return item.kind === 'file'
    && Boolean(item.sourceUri)
    && item.sha256 === '0'.repeat(64)
}

function createPreparingFileItem(
  asset: {mimeType?: string | null; name: string; size?: number; uri: string},
  itemId: string
): OutgoingTransferItem {
  return {
    itemId,
    kind: 'file',
    mimeType: asset.mimeType || 'application/octet-stream',
    name: asset.name || 'unnamed',
    sha256: '0'.repeat(64),
    sizeBytes: Number.isSafeInteger(asset.size) && asset.size! >= 0 ? asset.size! : 0,
    sourceUri: asset.uri,
    status: 'preparing',
    transferredBytes: 0
  }
}

async function prepareFileItem(
  asset: {mimeType?: string | null; name: string; size?: number; uri: string},
  itemId: string,
  onProgress: (preparedBytes: number, totalBytes: number) => void
): Promise<OutgoingTransferItem> {
  const source = new File(asset.uri)
  if (!source.exists) throw new TransferClientError('FILE_CHANGED')

  const stagingDirectory = new Directory(Paths.document, 'flowdrop-outgoing')
  stagingDirectory.create({idempotent: true, intermediates: true})
  const destination = new File(stagingDirectory, `${Crypto.randomUUID()}-${sanitizeFileName(asset.name)}`)
  // DocumentPicker has already copied the selected file into the app cache.
  // Moving within app storage avoids a second large native copy before hashing.
  await source.move(destination)
  if (!destination.exists) throw new TransferClientError('FILE_CHANGED')
  onProgress(0, destination.size)
  const hash = await hashFile(destination, onProgress)
  return {
    itemId,
    kind: 'file',
    mimeType: asset.mimeType || 'application/octet-stream',
    name: asset.name || 'unnamed',
    sha256: hash.sha256,
    sizeBytes: hash.sizeBytes,
    sourceUri: destination.uri,
    status: 'queued',
    transferredBytes: 0
  }
}

function sanitizeFileName(value: string) {
  return value.replace(/[\\/\u0000]/g, '_').slice(0, 180) || 'unnamed'
}

function getTransferFailureCode(error: unknown): import('@flowdrop/types').TransferFailureCode {
  if (!(error instanceof TransferClientError)) return 'PEER_OFFLINE'
  const codes: import('@flowdrop/types').TransferFailureCode[] = [
    'AUTHENTICATION_REQUIRED',
    'DEVICE_NOT_PAIRED',
    'FILE_CHANGED',
    'HASH_MISMATCH',
    'INSUFFICIENT_STORAGE',
    'INVALID_TRANSFER',
    'NETWORK_TIMEOUT',
    'PEER_OFFLINE',
    'PROTOCOL_VERSION_UNSUPPORTED',
    'TRANSFER_RECEIVE_DISABLED'
  ]
  return codes.includes(error.code as import('@flowdrop/types').TransferFailureCode)
    ? error.code as import('@flowdrop/types').TransferFailureCode
    : 'PEER_OFFLINE'
}

function isRemoteTransferMissing(error: unknown) {
  return error instanceof TransferClientError && error.code === 'TRANSFER_NOT_FOUND'
}

function isTerminalTransferStatus(status: OutgoingTransferTask['status']) {
  return status === 'cancelled' || status === 'completed' || status === 'failed'
}

function isPausableTransferStatus(status: OutgoingTransferTask['status']) {
  return status === 'completing'
    || status === 'negotiating'
    || status === 'transferring'
    || status === 'verifying'
}

function getTransferStatusLabel(status: OutgoingTransferTask['status']) {
  const labels: Record<OutgoingTransferTask['status'], string> = {
    cancelled: '已取消',
    completed: '已完成',
    completing: '正在完成',
    draft: '草稿',
    failed: '失败',
    negotiating: '正在协商',
    paused: '已暂停',
    preparing: '解析中',
    queued: '待传输',
    transferring: '传输中',
    verifying: '正在校验',
    waiting_for_peer: '等待对端'
  }
  return labels[status]
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

const styles = StyleSheet.create({
  screen: {
    flex: 1
  },
  headerButton: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    width: 40
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    maxWidth: 230
  },
  content: {
    paddingBottom: 32,
    paddingHorizontal: PAGE_HORIZONTAL_PADDING
  },
  devicePanel: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    elevation: 2,
    minHeight: 226,
    paddingBottom: 28,
    paddingTop: 34,
    shadowColor: '#000000',
    shadowOffset: {height: 2, width: 0},
    shadowOpacity: 0.08,
    shadowRadius: 5
  },
  deviceIcon: {
    alignItems: 'center',
    borderRadius: 44,
    height: 88,
    justifyContent: 'center',
    width: 88
  },
  statusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    marginTop: 15
  },
  onlineDot: {
    backgroundColor: '#29C967',
    borderRadius: 4,
    height: 8,
    marginRight: 7,
    width: 8
  },
  statusText: {
    fontSize: 14,
    fontWeight: '500'
  },
  ipBadge: {
    borderRadius: 6,
    marginTop: 10,
    paddingHorizontal: 13,
    paddingVertical: 6
  },
  ipText: {
    fontFamily: 'monospace',
    fontSize: 15,
    fontWeight: '500'
  },
  actionRow: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 24
  },
  actionCard: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    height: 152,
    justifyContent: 'center',
    minWidth: 0
  },
  primaryAction: {
    backgroundColor: '#050505',
    borderColor: '#050505'
  },
  actionPressed: {
    opacity: 0.78,
    transform: [{scale: 0.99}]
  },
  primaryActionText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
    marginTop: 18
  },
  secondaryActionText: {
    fontSize: 17,
    fontWeight: '700',
    marginTop: 18
  },
  sectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
    marginTop: 26,
    paddingHorizontal: 4
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700'
  },
  queueCount: {
    fontSize: 13,
    fontWeight: '500'
  },
  transferCard: {
    borderRadius: 8,
    borderWidth: 1,
    elevation: 1,
    padding: 20,
    shadowColor: '#000000',
    shadowOffset: {height: 1, width: 0},
    shadowOpacity: 0.06,
    shadowRadius: 4
  },
  emptyTransferText: {
    paddingHorizontal: 4,
    paddingVertical: 16
  },
  transferInfoRow: {
    alignItems: 'center',
    flexDirection: 'row'
  },
  fileIcon: {
    alignItems: 'center',
    borderRadius: 8,
    height: 54,
    justifyContent: 'center',
    width: 54
  },
  transferInfo: {
    flex: 1,
    marginLeft: 15,
    minWidth: 0
  },
  transferName: {
    fontSize: 16,
    fontWeight: '600'
  },
  transferMetaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    marginTop: 7
  },
  transferMeta: {
    fontFamily: 'monospace',
    fontSize: 13
  },
  metaDot: {
    borderRadius: 2,
    height: 4,
    marginHorizontal: 7,
    width: 4
  },
  transferSpeed: {
    fontFamily: 'monospace',
    fontSize: 13,
    fontWeight: '600'
  },
  progressTrack: {
    borderRadius: 2,
    height: 4,
    marginTop: 18,
    overflow: 'hidden'
  },
  progressBar: {
    backgroundColor: '#050505',
    borderRadius: 2,
    height: '100%'
  },
  queuedItem: {
    alignItems: 'center',
    flexDirection: 'row',
    minHeight: 82,
    paddingHorizontal: 18
  },
  queuedIcon: {
    alignItems: 'center',
    borderRadius: 7,
    height: 44,
    justifyContent: 'center',
    width: 44
  },
  queuedInfo: {
    flex: 1,
    marginLeft: 14,
    minWidth: 0
  },
  queuedName: {
    fontSize: 14,
    fontWeight: '500'
  },
  queuedStatus: {
    fontSize: 13,
    marginTop: 4
  },
  removeButton: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    marginLeft: 8,
    width: 40
  },
  transferCommandButton: {
    alignItems: 'center',
    borderRadius: 6,
    height: 36,
    justifyContent: 'center',
    marginLeft: 8,
    width: 36
  },
  transferActions: {
    flexDirection: 'row',
    gap: 6,
    marginLeft: 8
  },
  pauseButton: {
    backgroundColor: '#3468C0'
  },
  cancelButton: {
    alignItems: 'center',
    backgroundColor: '#C94C4C',
    borderRadius: 6,
    height: 36,
    justifyContent: 'center',
    width: 36
  },
  pressed: {
    opacity: 0.55
  }
})

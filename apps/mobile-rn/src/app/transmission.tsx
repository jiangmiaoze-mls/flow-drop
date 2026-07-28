import {useLocalSearchParams, useRouter} from 'expo-router'
import {SymbolView} from 'expo-symbols'
import {useCallback, useEffect, useRef, useState} from 'react'
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native'
import {SafeAreaView} from 'react-native-safe-area-context'

import {Header} from '@/components/Header'
import {BasicAlertDialog} from '@/components/BasicAlertDialog'
import TextDeliveryBottomSheet, {type TextDeliveryBottomSheetRef} from '@/components/TextDeliveryBottomSheet'
import {PAGE_HORIZONTAL_PADDING} from '@/constants/layout'
import {useTheme} from '@/hooks/use-theme'
import {getDeviceId} from '@/network/discoveryService'
import {
  sendV3TextMessage,
  textMessageByteLength,
  V3_TEXT_MESSAGE_MAX_BYTES
} from '@/network/v3TextMessageClient'
import {
  cancelNativeTransfer,
  deleteNativeOutgoingTransferFiles,
  getNativeTransferSnapshot,
  isNativeTransferControllerAvailable,
  pauseNativeTransfer,
  resumeNativeTransfer,
  stageNativeTransferSources,
  NativeTransferControllerError,
  type NativeTransferSnapshot
} from '@/network/nativeTransferController'
import {
  ensureNativeTransferStarted,
  projectNativeTransferSnapshot,
  projectNativeTransferStartFailure,
  subscribeToNativeTransferFailures,
  waitForNativeTransferStart
} from '@/network/nativeTransferProjectionRuntime'
import {
  CHUNK_DIGEST_MISMATCH,
  type V3OutgoingTransferTask,
  type V3TransferPendingOperation,
  type V3TransferProjectionUpdate,
  type V3TransferStatus
} from '@/storage/v3TransferProjectionRepository'
import {useV3TransferProjectionStore} from '@/store/useV3TransferProjectionStore'
import {
  markTextMessageDelivery,
  markTextMessageFailed,
  saveOutgoingTextMessage,
  type LocalTextMessage
} from '@/storage/v3TextMessageRepository'
import * as Crypto from 'expo-crypto'
import * as DocumentPicker from 'expo-document-picker'


const DEFAULT_CHUNK_SIZE_BYTES = 1024 * 1024

type TransmissionParams = {
  controlPort?: string
  id?: string
  ip?: string
  name?: string
  paired?: string
  type?: 'desktop' | 'laptop' | 'mobile'
}

type TransferPeer = {
  controlPort: number
  id: string
  ip: string
}

class V3TransferUiError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'V3TransferUiError'
  }
}

export default function Transmission() {
  const theme = useTheme()
  const router = useRouter()
  const params = useLocalSearchParams<TransmissionParams>()
  const tasksById = useV3TransferProjectionStore((state) => state.tasksById)
  const beginPendingOperation = useV3TransferProjectionStore((state) => state.beginPendingOperation)
  const createTransfer = useV3TransferProjectionStore((state) => state.createTransfer)
  const deleteTransfer = useV3TransferProjectionStore((state) => state.deleteTransfer)
  const flushPersistence = useV3TransferProjectionStore((state) => state.flushPersistence)
  const hydratePeer = useV3TransferProjectionStore((state) => state.hydratePeer)
  const rollbackPendingOperation = useV3TransferProjectionStore((state) => state.rollbackPendingOperation)
  const resolvePendingOperation = useV3TransferProjectionStore((state) => state.resolvePendingOperation)
  const isMounted = useRef(false)
  const hydratedPeers = useRef(new Set<string>())
  const presentedFailureEvents = useRef(new Set<string>())
  const [isChoosingFiles, setIsChoosingFiles] = useState(false)
  const [resendingTransferIds, setResendingTransferIds] = useState<Set<string>>(() => new Set())
  const textDeliverySheetRef = useRef<TextDeliveryBottomSheetRef>(null)
  const [transferError, setTransferError] = useState<string | null>(null)
  const nativeControllerAvailable = isNativeTransferControllerAvailable()
  const deviceName = params.name || '未知设备'
  const deviceIp = params.ip || '--'
  const isPaired = params.paired === 'true'
  const deviceIcon = params.type === 'desktop'
    ? {ios: 'desktopcomputer' as const, android: 'desktop_windows' as const, web: 'desktop_windows' as const}
    : {ios: 'laptopcomputer' as const, android: 'laptop_mac' as const, web: 'laptop_mac' as const}
  const outgoingTransfers = Object.values(tasksById)
    .filter((task) => task.peerDeviceId === params.id)
    .sort((left, right) => left.createdAt - right.createdAt)
  // An optimistic cancellation is not terminal until the Agent confirms it.
  // Keep it visible while native reconciliation retries after a lost network.
  const currentTransfers = outgoingTransfers.filter((task) => (
    !isTerminalTransferStatus(task.status)
      || (task.status === 'cancelled' && task.isOptimistic)
  ))
  const failedTransfers = outgoingTransfers.filter((task) => task.status === 'failed')
  const queueCount = currentTransfers.filter((task) => !isTerminalTransferStatus(task.status)).length

  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
      // Page teardown must not cancel the application-owned native upload.
      void flushPersistence().catch(() => undefined)
    }
  }, [flushPersistence])

  const handleBack = useCallback(() => {
    router.back()
  }, [router])

  const getTransferPeer = useCallback((): TransferPeer | null => {
    const controlPort = Number(params.controlPort)
    if (!params.id || !params.ip || !Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65_535) {
      return null
    }
    return {controlPort, id: params.id, ip: params.ip}
  }, [params.controlPort, params.id, params.ip])

  const projectNativeSnapshot = useCallback((snapshot: NativeTransferSnapshot) => {
    return projectNativeTransferSnapshot(snapshot)
  }, [])

  const reportTransferError = useCallback((error: unknown) => {
    if (isMounted.current) setTransferError(getTransferErrorMessage(error))
  }, [])

  const handleSendText = useCallback(async (content: string): Promise<boolean> => {
    const peer = getTransferPeer()
    if (!peer) {
      setTransferError('无法确定对方设备地址，请返回设备列表后重试。')
      return false
    }
    if (textMessageByteLength(content) < 1 || textMessageByteLength(content) > V3_TEXT_MESSAGE_MAX_BYTES) return false

    const messageId = Crypto.randomUUID()
    try {
      const localDeviceId = await getDeviceId()
      const optimistic: LocalTextMessage = {
        content,
        contentBytes: textMessageByteLength(content),
        createdAt: Date.now(),
        deliveryState: 'sending',
        messageId,
        peerDeviceId: peer.id,
        recipientDeviceId: peer.id,
        senderDeviceId: localDeviceId,
        sequence: 0
      }
      await saveOutgoingTextMessage(optimistic)
      const accepted = await sendV3TextMessage(
        {address: peer.ip, controlPort: peer.controlPort, deviceId: peer.id},
        {content, messageId}
      )
      await markTextMessageDelivery(accepted, peer.id)
      return true
    } catch (error) {
      await markTextMessageFailed(messageId).catch(() => undefined)
      if (isMounted.current) setTransferError(getTextMessageErrorMessage(error))
      return false
    }
  }, [getTransferPeer])

  const startNativeTask = useCallback(async (transferId: string, recovering: boolean): Promise<boolean> => {
    if (!nativeControllerAvailable) {
      reportTransferError(new NativeTransferControllerError('NATIVE_TRANSFER_UNAVAILABLE'))
      return false
    }
    try {
      return await ensureNativeTransferStarted(transferId, recovering)
    } catch (error) {
      projectNativeTransferStartFailure(transferId, error)
      reportTransferError(error)
      return false
    }
  }, [nativeControllerAvailable, reportTransferError])

  const settlePendingControl = useCallback(async (
    transferId: string,
    operation: V3TransferPendingOperation,
    response: Pick<V3TransferProjectionUpdate, 'revision' | 'status'>
  ) => {
    try {
      await resolvePendingOperation(transferId, operation, response)
    } catch (error) {
      // The store has already adopted the Agent result in memory and queued a
      // durable repair write. Surface the local persistence fault without
      // rolling back a control operation that the Agent accepted.
      reportTransferError(error)
    }
  }, [reportTransferError, resolvePendingOperation])

  const startNextQueuedTransfer = useCallback(async () => {
    if (!params.id) return
    const tasks = Object.values(useV3TransferProjectionStore.getState().tasksById)
      .filter((task) => task.peerDeviceId === params.id)
      .sort((left, right) => left.createdAt - right.createdAt)
    const firstIncomplete = tasks.find((task) => !isTerminalTransferStatus(task.status))
    if (!firstIncomplete || firstIncomplete.status !== 'queued' || firstIncomplete.pendingOperation) return
    await startNativeTask(firstIncomplete.transferId, false)
  }, [params.id, startNativeTask])

  useEffect(() => {
    void startNextQueuedTransfer()
  }, [outgoingTransfers, startNextQueuedTransfer])

  useEffect(() => subscribeToNativeTransferFailures((event) => {
    if (!params.id || isNonActionableNativeFailure(event.errorCode)) return
    const task = useV3TransferProjectionStore.getState().tasksById[event.transferId]
    if (!task || task.peerDeviceId !== params.id) return

    const eventKey = `${event.transferId}:${event.operationId}:${event.revision}:${event.errorCode}`
    if (presentedFailureEvents.current.has(eventKey)) return
    presentedFailureEvents.current.add(eventKey)
    reportTransferError(new V3TransferUiError(event.errorCode))
  }), [params.id, reportTransferError])

  useEffect(() => {
    if (!params.id || hydratedPeers.current.has(params.id)) return
    hydratedPeers.current.add(params.id)
    let active = true

    void (async () => {
      try {
        await hydratePeer(params.id!)
        if (!active || !nativeControllerAvailable) return
        const recoveringTasks = Object.values(useV3TransferProjectionStore.getState().tasksById)
          .filter((task) => task.peerDeviceId === params.id && shouldRecoverNativeTask(task))
          .sort((left, right) => left.createdAt - right.createdAt)
        for (const task of recoveringTasks) {
          if (!active) return
          await startNativeTask(task.transferId, true)
        }
      } catch (error) {
        if (active) reportTransferError(error)
      }
    })()

    return () => {
      active = false
    }
  }, [hydratePeer, nativeControllerAvailable, params.id, reportTransferError, startNativeTask])

  const handlePauseTransfer = useCallback(async (transferId: string) => {
    const task = useV3TransferProjectionStore.getState().tasksById[transferId]
    if (!task || task.pendingOperation || !isPausableTransferStatus(task.status)) return
    const originalStatus = task.status

    try {
      await beginPendingOperation(transferId, 'pause', 'paused')
      await waitForNativeTransferStart(transferId)
      let snapshot = nativeControllerAvailable ? await getNativeTransferSnapshot(transferId) : null
      if (!snapshot) {
        const started = await startNativeTask(transferId, true)
        if (!started && hasAuthoritativeTerminalTransfer(transferId)) return
        if (!started) throw new V3TransferUiError('TRANSFER_NOT_FOUND')
        snapshot = await getNativeTransferSnapshot(transferId)
      }
      if (!snapshot && hasAuthoritativeTerminalTransfer(transferId)) return
      if (!snapshot) throw new V3TransferUiError('TRANSFER_NOT_FOUND')

      const response = await retryNativeControl(() => pauseNativeTransfer(transferId))
      await settlePendingControl(transferId, 'pause', response)
    } catch (error) {
      await projectCurrentNativeSnapshot(transferId, projectNativeSnapshot)
      if (hasAuthoritativeTerminalTransfer(transferId)) return
      rollbackPendingOperation(transferId, 'pause', originalStatus)
      reportTransferError(error)
    }
  }, [beginPendingOperation, nativeControllerAvailable, projectNativeSnapshot, reportTransferError, rollbackPendingOperation, settlePendingControl, startNativeTask])

  const handleResumeTransfer = useCallback(async (transferId: string) => {
    const task = useV3TransferProjectionStore.getState().tasksById[transferId]
    if (!task || task.pendingOperation || task.status !== 'paused') return

    try {
      await beginPendingOperation(transferId, 'resume', 'transferring')
      await waitForNativeTransferStart(transferId)
      let snapshot = nativeControllerAvailable ? await getNativeTransferSnapshot(transferId) : null
      if (snapshot?.status === 'paused') {
        const restarted = await startNativeTask(transferId, true)
        if (!restarted && hasAuthoritativeTerminalTransfer(transferId)) return
        if (!restarted) throw new V3TransferUiError('TRANSFER_NOT_FOUND')
        snapshot = await getNativeTransferSnapshot(transferId)
      }
      if (!snapshot) {
        const started = await startNativeTask(transferId, true)
        if (!started && hasAuthoritativeTerminalTransfer(transferId)) return
        if (!started) throw new V3TransferUiError('TRANSFER_NOT_FOUND')
        snapshot = await getNativeTransferSnapshot(transferId)
      }
      if (!snapshot && hasAuthoritativeTerminalTransfer(transferId)) return
      if (!snapshot) throw new V3TransferUiError('TRANSFER_NOT_FOUND')

      const response = await retryNativeControl(() => resumeNativeTransfer(transferId))
      await settlePendingControl(transferId, 'resume', response)
    } catch (error) {
      await projectCurrentNativeSnapshot(transferId, projectNativeSnapshot)
      if (hasAuthoritativeTerminalTransfer(transferId)) return
      rollbackPendingOperation(transferId, 'resume', 'paused')
      reportTransferError(error)
    }
  }, [beginPendingOperation, nativeControllerAvailable, projectNativeSnapshot, reportTransferError, rollbackPendingOperation, settlePendingControl, startNativeTask])

  const handleCancelTransfer = useCallback(async (transferId: string) => {
    const task = useV3TransferProjectionStore.getState().tasksById[transferId]
    if (!task || task.pendingOperation || isTerminalTransferStatus(task.status)) return
    const originalStatus = task.status

    try {
      await beginPendingOperation(transferId, 'cancel', 'cancelled')
      await waitForNativeTransferStart(transferId)
      let snapshot = nativeControllerAvailable ? await getNativeTransferSnapshot(transferId) : null
      if (!snapshot) {
        const started = await startNativeTask(transferId, true)
        if (!started && hasAuthoritativeTerminalTransfer(transferId)) return
        // The native cancellation reconciler intentionally never creates a
        // missing remote task. Leave an unavailable reconciliation pending for
        // the next app start instead of treating it as a proved 404.
        if (!started) return
        snapshot = await getNativeTransferSnapshot(transferId)
      }
      if (hasAuthoritativeTerminalTransfer(transferId)) return
      if (!snapshot) throw new V3TransferUiError('TRANSFER_NOT_FOUND')

      const response = await retryNativeControl(() => cancelNativeTransfer(transferId))
      await settlePendingControl(transferId, 'cancel', response)
    } catch (error) {
      await projectCurrentNativeSnapshot(transferId, projectNativeSnapshot)
      if (hasAuthoritativeTerminalTransfer(transferId)) return
      if (getTransferErrorCode(error) === 'TRANSFER_NOT_FOUND') {
        await settlePendingControl(transferId, 'cancel', {revision: task.remoteRevision, status: 'cancelled'})
        return
      }
      rollbackPendingOperation(transferId, 'cancel', originalStatus)
      reportTransferError(error)
    }
  }, [beginPendingOperation, nativeControllerAvailable, projectNativeSnapshot, reportTransferError, rollbackPendingOperation, settlePendingControl, startNativeTask])

  const handleRetryTransfer = useCallback(async (transferId: string) => {
    const task = useV3TransferProjectionStore.getState().tasksById[transferId]
    if (!task || task.status !== 'waiting_for_peer' || task.pendingOperation) return

    try {
      await beginPendingOperation(transferId, 'resume', 'transferring')
      await waitForNativeTransferStart(transferId)
      const snapshot = nativeControllerAvailable ? await getNativeTransferSnapshot(transferId) : null
      if (snapshot?.status === 'waiting_for_peer') {
        try {
          const response = await retryNativeControl(() => resumeNativeTransfer(transferId))
          await settlePendingControl(transferId, 'resume', response)
          return
        } catch (error) {
          if (getTransferErrorCode(error) !== 'TRANSFER_NOT_FOUND') throw error
          // A network failure can happen before POST /v3/transfers created the
          // Agent task. The 404 is evidence to re-run native capability/create,
          // not a reason to leave this task permanently waiting.
          await settlePendingControl(transferId, 'resume', {
            revision: task.remoteRevision,
            status: 'recovering'
          })
          const restarted = await startNativeTask(transferId, true)
          if (!restarted && hasAuthoritativeTerminalTransfer(transferId)) return
          if (!restarted) throw new V3TransferUiError('TRANSFER_NOT_FOUND')
        }
        return
      }
      const started = await startNativeTask(transferId, true)
      if (!started && hasAuthoritativeTerminalTransfer(transferId)) return
      if (!started) throw new V3TransferUiError('TRANSFER_NOT_FOUND')
    } catch (error) {
      await projectCurrentNativeSnapshot(transferId, projectNativeSnapshot)
      if (hasAuthoritativeTerminalTransfer(transferId)) return
      rollbackPendingOperation(transferId, 'resume', 'waiting_for_peer')
      reportTransferError(error)
    }
  }, [beginPendingOperation, nativeControllerAvailable, projectNativeSnapshot, reportTransferError, rollbackPendingOperation, settlePendingControl, startNativeTask])

  const handleRetryCancelledTransfer = useCallback(async (transferId: string) => {
    const task = useV3TransferProjectionStore.getState().tasksById[transferId]
    if (task?.status !== 'cancelled' || !task.isOptimistic || task.pendingOperation !== 'cancel') return
    await startNativeTask(transferId, true)
  }, [startNativeTask])

  const handleResendFailedTransfer = useCallback(async (task: V3OutgoingTransferTask) => {
    if (task.status !== 'failed' || resendingTransferIds.has(task.transferId)) return
    setResendingTransferIds((current) => new Set(current).add(task.transferId))
    try {
      const replacement = await createTransfer({
        chunkSizeBytes: task.chunkSizeBytes,
        items: task.items.map((item) => ({...item, itemId: Crypto.randomUUID()})),
        peerAddress: task.peerAddress,
        peerControlPort: task.peerControlPort,
        peerDeviceId: task.peerDeviceId,
        sourceDeviceId: task.sourceDeviceId,
        transferId: Crypto.randomUUID()
      })
      void startNativeTask(replacement.transferId, false)
    } catch (error) {
      reportTransferError(error)
    } finally {
      setResendingTransferIds((current) => {
        const next = new Set(current)
        next.delete(task.transferId)
        return next
      })
    }
  }, [createTransfer, reportTransferError, resendingTransferIds, startNativeTask])

  const handleDeleteFailedTransfer = useCallback(async (transferId: string) => {
    const task = useV3TransferProjectionStore.getState().tasksById[transferId]
    if (!task || task.status !== 'failed') return
    try {
      await deleteNativeOutgoingTransferFiles(transferId)
      await deleteTransfer(transferId)
    } catch (error) {
      reportTransferError(error)
    }
  }, [deleteTransfer, reportTransferError])

  const chooseFile = useCallback(async () => {
    if (!nativeControllerAvailable) {
      reportTransferError(new NativeTransferControllerError('NATIVE_TRANSFER_UNAVAILABLE'))
      return
    }

    const peer = getTransferPeer()
    if (!peer) {
      reportTransferError(new V3TransferUiError('TRANSFER_ENDPOINT_UNAVAILABLE'))
      return
    }

    setIsChoosingFiles(true)
    try {
      const result = await DocumentPicker.getDocumentAsync({
        // The native stage operation consumes this external handle immediately.
        // SQLite receives only the resulting private file:// URI.
        copyToCacheDirectory: false,
        multiple: true
      })
      if (result.canceled) return

      const sourceDeviceId = await getDeviceId()
      for (const asset of result.assets) {
        const itemId = Crypto.randomUUID()
        const transferId = Crypto.randomUUID()
        const stagedSources = await stageNativeTransferSources({
          items: [{itemId, name: asset.name || 'unnamed', sizeBytes: requiredAssetSize(asset), sourceUri: asset.uri}],
          transferId
        })
        const sourceUri = stagedSources[itemId]
        if (!sourceUri?.startsWith('file://')) throw new V3TransferUiError('FILE_STAGE_FAILED')
        const item = prepareFileItem(asset, itemId, sourceUri)
        const task = await createTransfer({
          chunkSizeBytes: DEFAULT_CHUNK_SIZE_BYTES,
          items: [item],
          peerAddress: peer.ip,
          peerControlPort: peer.controlPort,
          peerDeviceId: peer.id,
          sourceDeviceId,
          transferId
        })
        void startNativeTask(task.transferId, false)
      }
    } catch (error) {
      reportTransferError(error)
    } finally {
      if (isMounted.current) setIsChoosingFiles(false)
    }
  }, [createTransfer, getTransferPeer, nativeControllerAvailable, reportTransferError, startNativeTask])

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
            accessibilityState={{disabled: isChoosingFiles || !nativeControllerAvailable}}
            disabled={isChoosingFiles || !nativeControllerAvailable}
            style={({pressed}) => [
              styles.actionCard,
              styles.primaryAction,
              (!nativeControllerAvailable || isChoosingFiles) && styles.actionDisabled,
              pressed && styles.actionPressed
            ]}
            onPress={() => void chooseFile()}>
            <SymbolView
              name={{ios: 'doc.badge.arrow.up', android: 'upload_file', web: 'upload_file'}}
              size={42}
              tintColor="#FFFFFF"
            />
            <Text style={styles.primaryActionText}>
              {isChoosingFiles ? '准备文件...' : nativeControllerAvailable ? '投递文件' : '原生传输不可用'}
            </Text>
          </Pressable>

          <Pressable
            accessibilityLabel="投递文字消息"
            accessibilityRole="button"
            accessibilityState={{disabled: !isPaired}}
            disabled={!isPaired}
            onPress={() => textDeliverySheetRef.current?.present()}
            style={({pressed}) => [
              styles.actionCard,
              !isPaired && styles.actionDisabled,
              {backgroundColor: theme.background, borderColor: theme.backgroundElement},
              pressed && styles.actionPressed
            ]}>
            <SymbolView
              name={{ios: 'text.bubble', android: 'chat', web: 'chat'}}
              size={42}
              tintColor={theme.textSecondary}
            />
            <Text style={[styles.secondaryActionText, {color: theme.textSecondary}]}>投递文字</Text>
          </Pressable>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, {color: theme.text}]}>当前传输</Text>
          <Text style={[styles.queueCount, {color: theme.textSecondary}]}>{queueCount} 项队列</Text>
        </View>

        {currentTransfers.length === 0 ? (
          <Text style={[styles.emptyTransferText, {color: theme.textSecondary}]}>尚无传输任务</Text>
        ) : currentTransfers.map((task) => {
          const detail = getTransferDetailLabel(task)
          const canRetry = task.status === 'waiting_for_peer' && !task.pendingOperation
          const canRetryCancellation = task.status === 'cancelled'
            && task.isOptimistic
            && task.pendingOperation === 'cancel'
          const canPause = isPausableTransferStatus(task.status) && !task.pendingOperation
          const canResume = task.status === 'paused' && !task.pendingOperation
          const canCancel = task.status === 'paused' && !task.pendingOperation
          const displayedBytes = getDisplayedProgressBytes(task)
          return (
            <View key={task.transferId} style={[styles.transferCard, {backgroundColor: theme.background, borderColor: theme.backgroundElement}]}>
              <View style={styles.transferInfoRow}>
                <View style={[styles.fileIcon, {backgroundColor: theme.backgroundElement}]}>
                  <SymbolView
                    name={{ios: 'doc.fill', android: 'description', web: 'description'}}
                    size={27}
                    tintColor={theme.text}
                  />
                </View>
                <View style={styles.transferInfo}>
                  <Text numberOfLines={1} style={[styles.transferName, {color: theme.text}]}>
                    {task.items[0]?.name ?? '未命名传输'}
                  </Text>
                  <View style={styles.transferMetaRow}>
                    <Text style={[styles.transferMeta, {color: theme.textSecondary}]}>
                      {formatBytes(displayedBytes)} / {formatBytes(task.totalBytes)} · {getTransferStatusLabel(task)}
                    </Text>
                    {task.status === 'transferring' && task.confirmedRateBytesPerSecond > 0 ? (
                      <>
                        <View style={[styles.metaDot, {backgroundColor: theme.textSecondary}]}/>
                        <Text style={[styles.transferSpeed, {color: theme.textSecondary}]}>
                          {formatBytes(task.confirmedRateBytesPerSecond)}/s
                        </Text>
                      </>
                    ) : null}
                  </View>
                  {detail ? <Text style={[styles.transferDetail, {color: theme.textSecondary}]}>{detail}</Text> : null}
                </View>
                <View style={styles.transferActions}>
                  {canRetry || canRetryCancellation ? (
                    <Pressable
                      accessibilityLabel={canRetryCancellation
                        ? '重试取消传输'
                        : '重试传输'}
                      accessibilityRole="button"
                      onPress={() => void (
                        canRetryCancellation
                          ? handleRetryCancelledTransfer(task.transferId)
                          : handleRetryTransfer(task.transferId)
                      )}
                      style={({pressed}) => [
                        styles.transferCommandButton,
                        {backgroundColor: theme.backgroundElement},
                        pressed && styles.pressed
                      ]}>
                      <SymbolView name={{ios: 'arrow.clockwise', android: 'refresh', web: 'refresh'}} size={18} tintColor={theme.text}/>
                    </Pressable>
                  ) : canResume ? (
                    <Pressable
                      accessibilityLabel="继续传输"
                      accessibilityRole="button"
                      onPress={() => void handleResumeTransfer(task.transferId)}
                      style={({pressed}) => [styles.transferCommandButton, {backgroundColor: theme.backgroundElement}, pressed && styles.pressed]}>
                      <SymbolView name={{ios: 'play.fill', android: 'play_arrow', web: 'play_arrow'}} size={17} tintColor={theme.text}/>
                    </Pressable>
                  ) : canPause ? (
                    <Pressable
                      accessibilityLabel="暂停传输"
                      accessibilityRole="button"
                      onPress={() => void handlePauseTransfer(task.transferId)}
                      style={({pressed}) => [styles.transferCommandButton, styles.pauseButton, pressed && styles.pressed]}>
                      <SymbolView name={{ios: 'pause.fill', android: 'pause', web: 'pause'}} size={15} tintColor="#FFFFFF"/>
                    </Pressable>
                  ) : null}
                  {canCancel ? (
                    <Pressable
                      accessibilityLabel="取消传输"
                      accessibilityRole="button"
                      onPress={() => void handleCancelTransfer(task.transferId)}
                      style={({pressed}) => [styles.cancelButton, pressed && styles.pressed]}>
                      <SymbolView name={{ios: 'xmark', android: 'close', web: 'close'}} size={18} tintColor="#FFFFFF"/>
                    </Pressable>
                  ) : null}
                </View>
              </View>
              {task.status !== 'failed' ? (
                <View style={[styles.progressTrack, {backgroundColor: theme.backgroundElement}]}>
                  <View style={[styles.progressBar, {width: `${task.totalBytes === 0 ? 0 : Math.min(100, displayedBytes / task.totalBytes * 100)}%`}]}/>
                </View>
              ) : null}
            </View>
          )
        })}

        {failedTransfers.length > 0 ? (
          <>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, {color: theme.text}]}>失败传输</Text>
              <Text style={[styles.queueCount, {color: theme.textSecondary}]}>{failedTransfers.length} 项</Text>
            </View>
            {failedTransfers.map((task) => {
              const isResending = resendingTransferIds.has(task.transferId)
              return (
                <View key={task.transferId} style={[styles.transferCard, {backgroundColor: theme.background, borderColor: theme.backgroundElement}]}>
                  <View style={styles.transferInfoRow}>
                    <View style={[styles.fileIcon, {backgroundColor: theme.backgroundElement}]}>
                      <SymbolView
                        name={{ios: 'exclamationmark.triangle.fill', android: 'error_outline', web: 'error_outline'}}
                        size={27}
                        tintColor="#C94C4C"
                      />
                    </View>
                    <View style={styles.transferInfo}>
                      <Text numberOfLines={1} style={[styles.transferName, {color: theme.text}]}>
                        {task.items[0]?.name ?? '未命名传输'}
                      </Text>
                      <Text style={[styles.transferMeta, {color: theme.textSecondary}]}>
                        {formatBytes(task.totalBytes)} · 失败
                      </Text>
                      <Text style={[styles.transferDetail, {color: theme.textSecondary}]}>
                        {getTransferDetailLabel(task)}
                      </Text>
                    </View>
                    <View style={styles.transferActions}>
                      <Pressable
                        accessibilityLabel="重新发送文件"
                        accessibilityRole="button"
                        accessibilityState={{disabled: isResending}}
                        disabled={isResending}
                        onPress={() => void handleResendFailedTransfer(task)}
                        style={({pressed}) => [
                          styles.transferCommandButton,
                          {backgroundColor: theme.backgroundElement},
                          isResending && styles.commandDisabled,
                          pressed && styles.pressed
                        ]}>
                        <SymbolView name={{ios: 'arrow.clockwise', android: 'refresh', web: 'refresh'}} size={18} tintColor={theme.text}/>
                      </Pressable>
                      <Pressable
                        accessibilityLabel="删除失败传输记录"
                        accessibilityRole="button"
                        onPress={() => void handleDeleteFailedTransfer(task.transferId)}
                        style={({pressed}) => [styles.deleteButton, pressed && styles.pressed]}>
                        <SymbolView name={{ios: 'trash', android: 'delete_outline', web: 'delete_outline'}} size={18} tintColor="#FFFFFF"/>
                      </Pressable>
                    </View>
                  </View>
                </View>
              )
            })}
          </>
        ) : null}
      </ScrollView>

      <TextDeliveryBottomSheet
        onSubmit={(text) => void handleSendText(text)}
        ref={textDeliverySheetRef}
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

async function projectCurrentNativeSnapshot(
  transferId: string,
  project: (snapshot: NativeTransferSnapshot) => boolean
) {
  try {
    const snapshot = await getNativeTransferSnapshot(transferId)
    if (snapshot) project(snapshot)
  } catch {
    // The original command error is more useful than a failed local snapshot read.
  }
}

function hasAuthoritativeTerminalTransfer(transferId: string): boolean {
  const task = useV3TransferProjectionStore.getState().tasksById[transferId]
  return Boolean(task && isTerminalTransferStatus(task.status) && !task.isOptimistic)
}

async function retryNativeControl<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (const delayMs of [0, 250, 500]) {
    if (delayMs > 0) await delay(delayMs)
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (getTransferErrorCode(error) !== 'TRANSFER_NOT_FOUND') throw error
    }
  }
  throw lastError
}

function prepareFileItem(
  asset: {mimeType?: string | null; name: string; size?: number; uri: string},
  itemId: string,
  sourceUri: string
) {
  const sizeBytes = requiredAssetSize(asset)

  return {
    itemId,
    mimeType: asset.mimeType || 'application/octet-stream',
    name: asset.name || 'unnamed',
    sizeBytes,
    sourceUri
  }
}

function requiredAssetSize(asset: {size?: number}): number {
  const sizeBytes = asset.size
  if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new V3TransferUiError('FILE_METADATA_UNAVAILABLE')
  }
  return sizeBytes
}

function shouldRecoverNativeTask(task: V3OutgoingTransferTask) {
  return !isTerminalTransferStatus(task.status)
    && task.status !== 'queued'
    && task.status !== 'paused'
    && task.status !== 'preparing'
    && !task.pendingOperation
}

function isPausableTransferStatus(status: V3TransferStatus) {
  return status === 'negotiating'
    || status === 'preparing'
    || status === 'queued'
    || status === 'recovering'
    || status === 'transferring'
    || status === 'waiting_for_peer'
}

function isTerminalTransferStatus(status: V3TransferStatus) {
  return status === 'cancelled' || status === 'completed' || status === 'failed'
}

function getDisplayedProgressBytes(task: V3OutgoingTransferTask) {
  return task.confirmedBytes
}

function getTransferDetailLabel(task: V3OutgoingTransferTask) {
  if (task.status === 'cancelled' && task.isOptimistic && task.pendingOperation === 'cancel') {
    return '正在等待对端确认取消'
  }
  if (task.status === 'paused') return ''
  if (task.status === 'failed') {
    if (task.failureCode === CHUNK_DIGEST_MISMATCH) {
      const mismatch = task.chunkDigestMismatches[0]
      if (mismatch) return `第 ${mismatch.index + 1} 块摘要不一致，请重新发送`
    }
    return getTransferFailureMessage(task.failureCode)
  }
  if (task.status === 'waiting_for_peer' && task.failureCode) {
    return getTransferFailureMessage(task.failureCode)
  }
  if (task.status === 'recovering') {
    if (task.recoveryManifestTotal > 0) {
      return `正在恢复传输状态 · 摘要清单 ${task.recoveryManifestEntries}/${task.recoveryManifestTotal}`
    }
    return '正在恢复传输状态'
  }
  if (task.isRepairing) return '正在同步传输状态'
  if (task.status === 'completing' && task.verifyingPhase !== 'idle') {
    return `正在校验本地落盘内容 · ${formatBytes(task.verifyingBytes)} / ${formatBytes(task.verifyingTotalBytes)}`
  }
  if (task.status === 'waiting_for_peer') return '正在等待对端恢复连接'
  return ''
}

function getTransferStatusLabel(task: V3OutgoingTransferTask) {
  if (task.status === 'cancelled' && task.isOptimistic && task.pendingOperation === 'cancel') {
    return '正在取消'
  }
  const {status} = task
  const labels: Record<V3TransferStatus, string> = {
    cancelled: '已取消',
    completed: '已完成',
    completing: '正在完成',
    draft: '草稿',
    failed: '失败',
    negotiating: '正在协商',
    paused: '已暂停',
    preparing: '准备中',
    queued: '待传输',
    recovering: '正在恢复',
    transferring: '传输中',
    verifying: '正在校验',
    waiting_for_peer: '等待对端'
  }
  return labels[status]
}

function getTransferErrorCode(error: unknown): string {
  if (error instanceof NativeTransferControllerError || error instanceof V3TransferUiError) return error.code
  if (error instanceof Error) {
    const match = error.message.match(/[A-Z][A-Z0-9_]{2,}/)
    if (match) return match[0]
  }
  return 'TRANSFER_ENDPOINT_UNAVAILABLE'
}

function getTransferErrorMessage(error: unknown): string {
  return getTransferFailureMessage(getTransferErrorCode(error))
}

function getTextMessageErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : 'TEXT_ENDPOINT_UNAVAILABLE'
  switch (code) {
    case 'AUTHENTICATION_REQUIRED': return '文字投递需要有效配对凭据，请重新配对。'
    case 'TRANSFER_RECEIVE_DISABLED': return '对方当前不接受来自此设备的文字消息。'
    case 'INVALID_TEXT_MESSAGE': return '文字内容必须为 1 至 1500 个 UTF-8 字节。'
    case 'TRANSFER_ENDPOINT_UNAVAILABLE': return '无法连接对方设备，消息已保存为发送失败。'
    case 'DEVICE_NOT_PAIRED': return '对方未保存此设备的配对关系，请重新配对。'
    default: return `文字消息发送失败（${code}）。`
  }
}

function getTransferFailureMessage(code: string | undefined): string {
  switch (code) {
    case 'AUTHENTICATION_REQUIRED':
      return '此设备的配对没有传输凭据，请解除信任后重新配对。'
    case 'AUTHENTICATION_UNAVAILABLE':
    case 'TRANSFER_AUTHORIZATION_UNAVAILABLE':
      return '对方暂时无法读取配对权限，请稍后重试。'
    case 'AUTHENTICATION_BACKPRESSURE':
      return '对方正在处理过多认证请求，请稍后重试。'
    case 'CHUNK_HASH_MISMATCH':
    case 'HASH_MISMATCH':
      return '文件分块校验失败，请重新选择文件后发送。'
    case 'FILE_ACCESS_NOT_PERSISTABLE':
      return '所选文件不支持断点恢复，请换用系统文件选择器重新选择。'
    case CHUNK_DIGEST_MISMATCH:
      return '文件校验失败，请重新发送。'
    case 'CONTENT_ROOT_MISMATCH':
    case 'PART_CONTENT_ROOT_MISMATCH':
      return '文件校验失败，请重新发送。'
    case 'FILE_CHANGED':
      return '文件在准备或传输期间发生变化，请重新选择文件。'
    case 'FILE_METADATA_UNAVAILABLE':
      return '无法读取文件大小，请重新选择文件。'
    case 'INSUFFICIENT_STORAGE':
      return '对方存储空间不足，无法接收文件。'
    case 'INVALID_TRANSFER':
    case 'INVALID_TRANSFER_REQUEST':
      return '传输请求无效，请重新选择文件后发送。'
    case 'NATIVE_TRANSFER_UNAVAILABLE':
      return '当前应用构建未包含 Android 原生传输控制器，不能回退到旧传输协议。'
    case 'NETWORK_TIMEOUT':
    case 'PEER_OFFLINE':
      return '无法连接对方设备，请确认对方在线且处于同一局域网。'
    case 'PART_READ_ERROR':
      return '接收端暂存文件读取失败，请重新发送文件。'
    case 'TRANSFER_RECEIVE_DISABLED':
      return '对方当前不接受来自此设备的传输。'
    case 'PROTOCOL_VERSION_UNSUPPORTED':
      return '对方不支持当前传输协议，请更新双方应用后重试。'
    case 'TRANSFER_CLOSING':
    case 'TRANSFER_COMPLETION_CONFLICT':
      return '对方正在完成或校验传输，请等待当前状态同步。'
    case 'TRANSFER_INCOMPLETE':
      return '传输尚未接收完整，无法完成文件校验。'
    case 'DEVICE_NOT_PAIRED':
      return '对方未保存此设备的配对关系，请重新配对。'
    case 'V3_CAPABILITY_UNAVAILABLE':
      return '接收端需更新后才能使用文件传输。'
    case 'TRANSFER_NOT_FOUND':
      return '对端没有可恢复的传输任务，请重新发送文件。'
    case 'TRANSFER_STATE_INVALID':
      return '当前传输状态不允许该操作。'
    case 'TRANSFER_ENDPOINT_UNAVAILABLE':
      return '无法连接对方设备，任务会保留等待后续重试。'
    case 'TRANSFER_PAUSED':
      return '传输已在对方暂停，请恢复后重试。'
    case 'TRANSFER_PROTOCOL_ERROR':
      return '对方返回了无效的传输协议数据，请更新双方应用后重试。'
    case 'TRANSFER_RECOVERY_CONFIG_INVALID':
      return '本地恢复信息无效，请重新选择文件并发送。'
    case 'STATUS_REPAIR_RATE_LIMITED':
      return '传输状态同步过于频繁，请稍后重试。'
    case 'TRANSFER_FAILED':
      return '对方已将该传输标记为失败，请重新发送文件。'
    default:
      return code
        ? `传输失败（${code}），请确认双方已更新且处于同一局域网。`
        : '传输失败，未收到具体错误原因，请检查对方 Agent 日志。'
  }
}

function isNonActionableNativeFailure(code: string): boolean {
  return code === 'TRANSFER_CANCELLED' || code === 'TRANSFER_SUPERSEDED'
}

function isPeerUnavailableError(code: string) {
  return code === 'NETWORK_TIMEOUT' || code === 'PEER_OFFLINE' || code === 'TRANSFER_ENDPOINT_UNAVAILABLE'
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`
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
  actionDisabled: {
    opacity: 0.48
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
    marginBottom: 10,
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
  transferDetail: {
    fontSize: 12,
    marginTop: 5
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
  transferCommandButton: {
    alignItems: 'center',
    borderRadius: 6,
    height: 36,
    justifyContent: 'center',
    marginLeft: 8,
    width: 36
  },
  commandDisabled: {
    opacity: 0.48
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
  deleteButton: {
    alignItems: 'center',
    backgroundColor: '#68707A',
    borderRadius: 6,
    height: 36,
    justifyContent: 'center',
    width: 36
  },
  pressed: {
    opacity: 0.55
  }
})

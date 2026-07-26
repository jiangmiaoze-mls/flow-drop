import {useLocalSearchParams, useRouter} from 'expo-router'
import {SymbolView} from 'expo-symbols'
import {useCallback, useRef, useState} from 'react'
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
import type {Device} from '@flowdrop/types'
import * as DocumentPicker from 'expo-document-picker'


type TransmissionParams = {
  controlPort?: string
  id?: string
  ip?: string
  name?: string
  paired?: string
  type?: 'desktop' | 'laptop' | 'mobile'
}

const TRANSFER_PROGRESS = 24.5 / 128

export default function Transmission() {
  const theme = useTheme()
  const router = useRouter()
  const textDeliveryBottomSheetRef = useRef<TextDeliveryBottomSheetRef>(null)
  const params = useLocalSearchParams<TransmissionParams>()
  const [isQueuedItemVisible, setIsQueuedItemVisible] = useState(true)
  const [isCheckingPermission, setIsCheckingPermission] = useState(false)
  const [transferError, setTransferError] = useState<string | null>(null)
  const deviceName = params.name || '未知设备'
  const deviceIp = params.ip || '--'
  const isPaired = params.paired === 'true'
  const deviceIcon = params.type === 'desktop'
    ? {ios: 'desktopcomputer' as const, android: 'desktop_windows' as const, web: 'desktop_windows' as const}
    : {ios: 'laptopcomputer' as const, android: 'laptop_mac' as const, web: 'laptop_mac' as const}
  const queueCount = isQueuedItemVisible ? 2 : 1

  const handleBack = useCallback(() => {
    router.back()
  }, [router])

  const handleRemoveQueuedItem = useCallback(() => {
    setIsQueuedItemVisible(false)
  }, [])

  const handleOpenTextDelivery = useCallback(() => {
    textDeliveryBottomSheetRef.current?.present()
  }, [])

  const verifyTargetAllowsTransfer = useCallback(async (): Promise<boolean> => {
    const controlPort = Number(params.controlPort)
    if (!params.id || !params.ip || !params.type || !Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65_535) {
      setTransferError('当前设备未提供可用的传输服务，请返回设备列表后重试。')
      return false
    }

    const peer: Device = {
      controlPort,
      id: params.id,
      ip: params.ip,
      name: deviceName,
      paired: isPaired,
      type: params.type
    }

    setIsCheckingPermission(true)
    try {
      await requestTransferAdmission(peer, await getDeviceId())
      return true
    } catch (error) {
      setTransferError(getTransferErrorMessage(error))
      return false
    } finally {
      setIsCheckingPermission(false)
    }
  }, [deviceName, isPaired, params.controlPort, params.id, params.ip, params.type])

  const chooseFile = useCallback(async () => {
    if (!await verifyTargetAllowsTransfer()) return

    const result = await DocumentPicker.getDocumentAsync({
      multiple: true
    })

    if (result.canceled) return

    for (let asset of result.assets) {
    }
  }, [verifyTargetAllowsTransfer])

  const handleTextDelivery = useCallback(async (_text: string): Promise<boolean> => {
    return verifyTargetAllowsTransfer()
  }, [verifyTargetAllowsTransfer])

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

        <View
          style={[
            styles.transferCard,
            {backgroundColor: theme.background, borderColor: theme.backgroundElement}
          ]}>
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
                Q4_Financial_Report_Final_v2.pdf
              </Text>
              <View style={styles.transferMetaRow}>
                <Text style={[styles.transferMeta, {color: theme.textSecondary}]}>24.5 MB / 128 MB</Text>
                <View style={[styles.metaDot, {backgroundColor: theme.backgroundSelected}]}/>
                <Text style={[styles.transferSpeed, {color: theme.text}]}>18 MB/s</Text>
              </View>
            </View>
          </View>

          <View style={[styles.progressTrack, {backgroundColor: theme.backgroundElement}]}>
            <View style={[styles.progressBar, {width: `${TRANSFER_PROGRESS * 100}%`}]}/>
          </View>
        </View>

        {isQueuedItemVisible ? (
          <View style={styles.queuedItem}>
            <View style={[styles.queuedIcon, {backgroundColor: theme.backgroundElement}]}>
              <SymbolView
                name={{ios: 'archivebox.fill', android: 'folder_zip', web: 'folder_zip'}}
                size={21}
                tintColor={theme.textSecondary}
              />
            </View>

            <View style={styles.queuedInfo}>
              <Text numberOfLines={1} style={[styles.queuedName, {color: theme.text}]}>Design_Assets_Pack.zip</Text>
              <Text style={[styles.queuedStatus, {color: theme.textSecondary}]}>等待中</Text>
            </View>

            <Pressable
              accessibilityLabel="移除等待中的传输"
              accessibilityRole="button"
              hitSlop={10}
              onPress={handleRemoveQueuedItem}
              style={({pressed}) => [styles.removeButton, pressed && styles.pressed]}>
              <SymbolView
                name={{ios: 'xmark', android: 'close', web: 'close'}}
                size={19}
                tintColor={theme.textSecondary}
              />
            </Pressable>
          </View>
        ) : null}
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
  pressed: {
    opacity: 0.55
  }
})

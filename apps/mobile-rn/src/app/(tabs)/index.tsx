import * as ExpoDevice from 'expo-device'
import {useRouter} from 'expo-router'
import {SymbolView} from 'expo-symbols'
import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {FlatList, Platform, Pressable, StyleSheet, Text, View} from 'react-native'

import {BasicAlertDialog} from '@/components/BasicAlertDialog'
import ConnectionBottomSheet, {type ConnectionBottomSheetRef} from '@/components/ConnectionBottomSheet'
import {DiscoveryPulse} from '@/components/DiscoveryPulse'
import {Header} from '@/components/Header'
import {PAGE_HORIZONTAL_PADDING} from '@/constants/layout'
import {useTheme} from '@/hooks/use-theme'
import {DiscoveryService} from '@/network/discoveryService'
import {PairingError, verifyPairingCode} from '@/network/pairingClient'
import {setTransferSecret} from '@/storage/transferCredentialRepository'
import {useTrustedDevicesStore} from '@/store/useTrustedDevicesStore'
import {getWifiIPv4BroadcastTargetAsync} from '@flowdrop/network/mobile'
import type {Device, DiscoveredDevice, TrustedDevice} from '@flowdrop/types'
import {useAccessFineLocationPermission} from '@/hooks/usePermissions'


function toDevice(discoveredDevice: DiscoveredDevice): Device {
  return {
    id: discoveredDevice.deviceId,
    ip: discoveredDevice.address,
    name: discoveredDevice.deviceName,
    type: 'desktop',
    controlPort: discoveredDevice.controlPort
  }
}

function sortDevices(devices: Device[]): Device[] {
  return [...devices].sort((left, right) => left.name.localeCompare(right.name))
}

type PermissionsTipsProps = {
  onOpenSettings: () => void
}

function PermissionsTips({onOpenSettings}: PermissionsTipsProps) {
  const theme = useTheme()

  return (
    <View style={[styles.permissionsTip, {
      backgroundColor: theme.backgroundElement,
      borderColor: theme.backgroundSelected
    }]}>
      <SymbolView
        name={{ios: 'questionmark.circle', android: 'help_outline', web: 'help_outline'}}
        size={25}
        tintColor={theme.textSecondary}
      />
      <View style={styles.permissionsTipContent}>
        <Text style={[styles.permissionsTipText, {color: theme.textSecondary}]}>未获取权限。</Text>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="查看权限授权引导"
          hitSlop={6}
          onPress={onOpenSettings}>
          <Text style={[styles.permissionsGuideText, {color: theme.text}]}>去设置开启</Text>
        </Pressable>
      </View>
    </View>
  )
}

type HomeListHeaderProps = {
  hasLocationPermission: boolean
  onOpenLocationSettings: () => void
}

function HomeListHeader({hasLocationPermission, onOpenLocationSettings}: HomeListHeaderProps) {
  const theme = useTheme()

  return (
    <View style={styles.listHeader}>
      <View style={styles.discoverySection}>
        <DiscoveryPulse/>

        {
          hasLocationPermission ?
            <>
              <Text style={[styles.discoveryText, {color: theme.textSecondary}]}>正在寻找局域网中的电脑...</Text>
              <Pressable
                accessibilityLabel="手动输入 IP 连接"
                accessibilityRole="button"
                style={({pressed}) => [
                  styles.manualConnectButton,
                  {backgroundColor: theme.backgroundElement},
                  pressed && styles.manualConnectButtonPressed
                ]}>
                <SymbolView
                  name={{ios: 'keyboard', android: 'keyboard', web: 'keyboard'}}
                  size={20}
                  tintColor={theme.textSecondary}
                />
                <Text style={[styles.manualConnectText, {color: theme.textSecondary}]}>手动输入 IP 连接</Text>
              </Pressable>
            </> :
            <PermissionsTips onOpenSettings={onOpenLocationSettings}/>
        }
      </View>
    </View>
  )
}

type DeviceCardProps = {
  device: Device
  onPress: (device: Device) => void
}

function DeviceCard({device, onPress}: DeviceCardProps) {
  const theme = useTheme()
  const iconName = device.type === 'desktop'
    ? {ios: 'desktopcomputer' as const, android: 'desktop_windows' as const, web: 'desktop_windows' as const}
    : {ios: 'laptopcomputer' as const, android: 'laptop_mac' as const, web: 'laptop_mac' as const}

  return (
    <View
      style={[
        styles.deviceCard,
        {backgroundColor: theme.backgroundElement},
        device.paired && styles.authorizedCard
      ]}>
      <View style={styles.deviceIcon}>
        <SymbolView name={iconName} size={27} tintColor="#111111"/>
      </View>

      <View style={styles.deviceInfo}>
        <View style={styles.deviceNameRow}>
          <Text numberOfLines={1} style={[styles.deviceName, {color: theme.text}]}>{device.name}</Text>
          {device.paired ? (
            <View style={styles.authorizedBadge}>
              <Text style={styles.authorizedText}>已配对</Text>
            </View>
          ) : null}
        </View>
        <Text style={[styles.deviceIp, {color: theme.textSecondary}]}>{device.ip}</Text>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${device.paired ? '进入传输' : '连接'} ${device.name}`}
        onPress={() => onPress(device)}
        style={({pressed}) => [styles.actionButton, pressed && styles.actionButtonPressed]}>
        <Text style={styles.actionButtonText}>{device.paired ? '传输' : '连接'}</Text>
      </Pressable>
    </View>
  )
}

export default function FindDevice() {
  const theme = useTheme()
  const connectionSheetRef = useRef<ConnectionBottomSheetRef>(null)
  const discoveryServiceRef = useRef<DiscoveryService | null>(null)
  const [discoveredDevices, setDiscoveredDevices] = useState<Device[]>([])
  const [pendingPairDevice, setPendingPairDevice] = useState<Device | null>(null)
  const [pairingError, setPairingError] = useState<string | null>(null)
  const router = useRouter()
  const trustedDevices = useTrustedDevicesStore((state) => state.devices)
  const loadTrustedDevices = useTrustedDevicesStore((state) => state.load)
  const saveTrustedDevice = useTrustedDevicesStore((state) => state.save)
  const {
    isLocationPermissionGranted,
    openLocationPermissionSettings,
    requestAccessFineLocationPermissionIfNeeded
  } = useAccessFineLocationPermission()
  const hasDiscoveryPermission = Platform.OS === 'ios' || (
    Platform.OS === 'android' && isLocationPermissionGranted
  )
  const trustedDevicesById = useMemo(
    () => new Map(trustedDevices.map((device) => [device.deviceId, device])),
    [trustedDevices]
  )
  const devices = useMemo(() => (
    discoveredDevices.map((device) => ({
      ...device,
      paired: trustedDevicesById.has(device.id)
    }))
  ), [discoveredDevices, trustedDevicesById])

  const handleDevicePress = useCallback((device: Device) => {
    if (!device.paired) {
      setPairingError(null)
      setPendingPairDevice(device)
      connectionSheetRef.current?.present()
      return
    }

    router.push({
      pathname: '/transmission',
      params: {
        controlPort: device.controlPort?.toString(),
        id: device.id,
        ip: device.ip,
        name: device.name,
        paired: device.paired ? 'true' : 'false',
        type: device.type
      }
    })
  }, [router])

  const handleConfirmConnection = useCallback(async (code: string) => {
    const peer = pendingPairDevice
    const localDeviceId = discoveryServiceRef.current?.deviceId
    if (!peer || !localDeviceId) {
      setPairingError('设备发现尚未完成，请稍后重试。')
      return false
    }

    try {
      const deviceName = ExpoDevice.deviceName?.trim() || ExpoDevice.modelName?.trim() || 'FlowDrop Mobile'
      const pairingResult = await verifyPairingCode(peer, {
        code,
        deviceId: localDeviceId,
        deviceKind: 'mobile',
        deviceName
      })

      await setTransferSecret(peer.id, pairingResult.transferSecret)

      const now = Date.now()
      const existingDevice = trustedDevicesById.get(peer.id)
      saveTrustedDevice(toTrustedDevice(peer, existingDevice, now))
      setPendingPairDevice(null)
      connectionSheetRef.current?.dismiss()
      router.push({
        pathname: '/transmission',
        params: {
          controlPort: peer.controlPort?.toString(),
          id: peer.id,
          ip: peer.ip,
          name: peer.name,
          paired: 'true',
          type: peer.type
        }
      })
      return true
    } catch (error) {
      setPairingError(getPairingErrorMessage(error))
      return false
    }
  }, [pendingPairDevice, router, saveTrustedDevice, trustedDevicesById])

  const renderDevice = useCallback(({item}: { item: Device }) => (
    <DeviceCard device={item} onPress={handleDevicePress}/>
  ), [handleDevicePress])

  useEffect(() => {
    if (Platform.OS !== 'android') return
    void requestAccessFineLocationPermissionIfNeeded()
  }, [requestAccessFineLocationPermissionIfNeeded])

  useEffect(() => {
    loadTrustedDevices()
  }, [loadTrustedDevices])

  useEffect(() => {
    if (!hasDiscoveryPermission) {
      setDiscoveredDevices([])
      return
    }

    let discoveryService: DiscoveryService | null = null
    let unsubscribe: () => void = () => undefined
    let disposed = false

    const startDiscovery = async () => {
      const deviceName = ExpoDevice.deviceName?.trim() || ExpoDevice.modelName?.trim() || 'FlowDrop Mobile'
      let broadcastAddress: string | undefined

      if (Platform.OS === 'android') {
        try {
          broadcastAddress = (await getWifiIPv4BroadcastTargetAsync())?.broadcastAddress
        } catch (error) {
          console.warn('Unable to determine the Wi-Fi directed broadcast address.', error)
        }
      }
      if (disposed) return

      const service = new DiscoveryService(deviceName, {broadcastAddress})
      discoveryService = service
      discoveryServiceRef.current = service
      unsubscribe = service.subscribe((event) => {
        if (disposed) return

        if (event.type === 'error') {
          console.warn('Local network discovery failed.', event.error)
          return
        }

        if (event.type === 'deviceLost') {
          setDiscoveredDevices((currentDevices) => currentDevices.filter((device) => device.id !== event.device.deviceId))
          return
        }

        const nextDevice = toDevice(event.device)
        setDiscoveredDevices((currentDevices) => {
          const deviceIndex = currentDevices.findIndex((device) => device.id === nextDevice.id)
          if (deviceIndex === -1) return sortDevices([...currentDevices, nextDevice])

          const nextDevices = [...currentDevices]
          nextDevices[deviceIndex] = nextDevice
          return sortDevices(nextDevices)
        })
      })

      await service.start()
      if (discoveryServiceRef.current === service) {
        setDiscoveredDevices(sortDevices(service.getDiscoveredDevices().map(toDevice)))
      }
    }

    void startDiscovery().catch((error: unknown) => {
      if (!disposed) console.warn('Failed to start local network discovery.', error)
    })

    return () => {
      disposed = true
      unsubscribe()
      if (discoveryServiceRef.current === discoveryService) {
        discoveryServiceRef.current = null
      }
      discoveryService?.stop()
    }
  }, [hasDiscoveryPermission])

  return (
    <View style={[styles.screen, {backgroundColor: theme.background}]}>
      <Header>
        <Header.Center>
          <Text style={[styles.headerTitle, {color: theme.text}]}>FlowDrop</Text>
        </Header.Center>
      </Header>

      <FlatList
        contentContainerStyle={styles.contentContainer}
        data={devices}
        ItemSeparatorComponent={DeviceSeparator}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={(
          <HomeListHeader
            hasLocationPermission={hasDiscoveryPermission}
            onOpenLocationSettings={openLocationPermissionSettings}
          />
        )}
        ListEmptyComponent={hasDiscoveryPermission ? <EmptyDeviceList/> : null}
        renderItem={renderDevice}
        showsVerticalScrollIndicator={false}
        style={styles.list}
      />

      <ConnectionBottomSheet
        ref={connectionSheetRef}
        onConfirm={handleConfirmConnection}
      />

      <BasicAlertDialog
        confirmText="知道了"
        message={pairingError ?? ''}
        onConfirm={() => setPairingError(null)}
        title="配对失败"
        visible={pairingError !== null}
      />
    </View>
  )
}

function DeviceSeparator() {
  return <View style={styles.separator}/>
}

function getPairingErrorMessage(error: unknown): string {
  if (error instanceof PairingError) {
    if (error.code === 'PAIRING_REJECTED') {
      return '对方拒绝了此次配对请求。'
    }
    if (error.code === 'PAIRING_APPROVAL_EXPIRED') {
      return '等待对方确认超时，请重新发起配对。'
    }
    return '配对码无效、已过期，或已达到尝试次数上限。'
  }

  const message = error instanceof Error ? error.message : ''

  if (message.includes('Failed to connect') || message.includes('ConnectException')) {
    return '无法连接目标设备。请确认电脑端 Agent 已启动，并允许局域网设备访问。'
  }

  return '无法完成配对，请确认目标设备在线后重试。'
}

function toTrustedDevice(device: Device, existingDevice: TrustedDevice | undefined, now: number): TrustedDevice {
  return {
    controlPort: device.controlPort,
    deviceId: device.id,
    deviceKind: device.type,
    deviceName: device.name,
    lastKnownAddress: device.ip,
    lastSeenAt: now,
    pairedAt: existingDevice?.pairedAt ?? now,
    receiveEnabled: existingDevice?.receiveEnabled ?? true,
    updatedAt: now
  }
}

function EmptyDeviceList() {
  const theme = useTheme()

  return (
    <Text style={[styles.emptyDeviceListText, {color: theme.textSecondary}]}>暂未发现可连接的设备</Text>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1
  },
  list: {
    flex: 1
  },
  contentContainer: {
    paddingBottom: 28
  },
  listHeader: {},
  headerTitle: {
    fontSize: 23,
    fontWeight: '700'
  },
  discoverySection: {
    alignItems: 'center',
    paddingBottom: 20,
    paddingTop: 12
  },
  discoveryText: {
    fontSize: 15,
    marginTop: 8
  },
  manualConnectButton: {
    alignItems: 'center',
    borderRadius: 22,
    flexDirection: 'row',
    height: 44,
    justifyContent: 'center',
    marginTop: 16,
    paddingHorizontal: 20
  },
  manualConnectButtonPressed: {
    opacity: 0.72
  },
  manualConnectText: {
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 9
  },
  permissionsTip: {
    alignItems: 'center',
    alignSelf: 'stretch',
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    marginHorizontal: PAGE_HORIZONTAL_PADDING,
    marginTop: 22,
    minHeight: 78,
    paddingHorizontal: 18
  },
  permissionsTipContent: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginLeft: 15,
    minWidth: 0
  },
  permissionsTipText: {
    fontSize: 16,
    lineHeight: 24
  },
  permissionsGuideText: {
    fontSize: 16,
    lineHeight: 24,
    textDecorationLine: 'underline'
  },
  deviceCard: {
    alignItems: 'center',
    borderColor: 'transparent',
    borderRadius: 8,
    borderWidth: 1.5,
    flexDirection: 'row',
    marginHorizontal: PAGE_HORIZONTAL_PADDING,
    minHeight: 92,
    paddingHorizontal: 14,
    paddingVertical: 14
  },
  authorizedCard: {
    backgroundColor: '#EFFAF3',
    borderColor: '#B7EDC8'
  },
  deviceIcon: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 26,
    height: 52,
    justifyContent: 'center',
    width: 52
  },
  deviceInfo: {
    flex: 1,
    marginLeft: 13,
    minWidth: 0
  },
  deviceNameRow: {
    alignItems: 'center',
    flexDirection: 'row'
  },
  deviceName: {
    flexShrink: 1,
    fontSize: 17,
    fontWeight: '700'
  },
  authorizedBadge: {
    backgroundColor: '#C9F3D6',
    borderRadius: 10,
    marginLeft: 8,
    paddingHorizontal: 7,
    paddingVertical: 3
  },
  authorizedText: {
    color: '#1DAA54',
    fontSize: 11,
    fontWeight: '600'
  },
  deviceIp: {
    fontSize: 14,
    marginTop: 5
  },
  actionButton: {
    alignItems: 'center',
    backgroundColor: '#0B0B0B',
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    marginLeft: 10,
    paddingHorizontal: 17
  },
  actionButtonPressed: {
    opacity: 0.72,
    transform: [{scale: 0.98}]
  },
  actionButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700'
  },
  separator: {
    height: 14
  },
  emptyDeviceListText: {
    fontSize: 15,
    paddingHorizontal: PAGE_HORIZONTAL_PADDING,
    paddingTop: 16,
    textAlign: 'center'
  }
})

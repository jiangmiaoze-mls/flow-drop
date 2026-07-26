import {SymbolView} from 'expo-symbols'
import * as ExpoDevice from 'expo-device'
import {useEffect, useState} from 'react'
import {Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View} from 'react-native'

import {Header} from '@/components/Header'
import {PAGE_HORIZONTAL_PADDING} from '@/constants/layout'
import {useTheme} from '@/hooks/use-theme'
import {getDeviceId} from '@/network/discoveryService'
import {mobilePairingService} from '@/network/mobilePairingService'
import {useTrustedDevicesStore} from '@/store/useTrustedDevicesStore'
import {getWifiIPv4BroadcastTargetAsync} from '@flowdrop/network/mobile'
import type {PairingSession, TrustedDevice} from '@flowdrop/types'

type LocalDeviceInfo = {
  deviceId: string
  deviceName: string
  ipAddress: string | null
}

function DeviceDetail({label, value}: {label: string, value: string}) {
  const theme = useTheme()

  return (
    <View style={styles.deviceDetail}>
      <Text style={[styles.deviceDetailLabel, {color: theme.textSecondary}]}>{label}</Text>
      <Text numberOfLines={1} style={[styles.deviceDetailValue, {color: theme.text}]}>{value}</Text>
    </View>
  )
}

function MyDeviceCard({
  device,
  pairingSession,
  onRefreshPairingCode
}: {
  device: LocalDeviceInfo | null
  pairingSession: PairingSession | null
  onRefreshPairingCode: () => void
}) {
  const theme = useTheme()
  const deviceName = device?.deviceName ?? '正在读取设备信息'
  const deviceId = device?.deviceId ?? '正在读取'
  const ipAddress = device?.ipAddress ?? (Platform.OS === 'android' ? '未获取到 Wi-Fi IPv4 地址' : 'iOS 当前未提供 Wi-Fi IPv4 地址')

  return (
    <View style={[styles.card, {backgroundColor: theme.backgroundElement}]}>
      <View style={styles.deviceRow}>
        <View style={styles.deviceIcon}>
          <SymbolView
            name={{ios: 'iphone', android: 'smartphone', web: 'smartphone'}}
            size={27}
            tintColor={theme.text}
          />
        </View>
        <View style={styles.deviceInfo}>
          <Text numberOfLines={1} style={[styles.deviceName, {color: theme.text}]}>{deviceName}</Text>
          <Text numberOfLines={1} style={[styles.deviceAddress, {color: theme.textSecondary}]}>本机移动设备</Text>
        </View>
      </View>

      <View style={[styles.details, {borderTopColor: theme.backgroundSelected}]}>
        <DeviceDetail label="IP 地址" value={ipAddress}/>
        <DeviceDetail label="设备 ID" value={deviceId}/>
        <DeviceDetail label="配对码" value={pairingSession?.code ?? '正在生成'}/>
      </View>
      <View style={styles.pairingFooter}>
        <Text style={[styles.pairingHint, {color: theme.textSecondary}]}>配对码仅可使用一次{pairingSession ? `，有效至 ${formatPairingExpiry(pairingSession.expiresAt)}` : ''}。</Text>
        <Pressable
          accessibilityLabel="刷新配对码"
          accessibilityRole="button"
          onPress={onRefreshPairingCode}
          style={({pressed}) => [styles.refreshCodeButton, {backgroundColor: theme.backgroundSelected}, pressed && styles.refreshCodeButtonPressed]}>
          <Text style={[styles.refreshCodeButtonText, {color: theme.text}]}>刷新</Text>
        </Pressable>
      </View>
    </View>
  )
}

function TrustedDeviceCard({
  device,
  onReceiveEnabledChange
}: {
  device: TrustedDevice
  onReceiveEnabledChange: (receiveEnabled: boolean) => void
}) {
  const theme = useTheme()
  const icon = device.deviceKind === 'mobile'
    ? {ios: 'iphone', android: 'smartphone', web: 'smartphone'} as const
    : device.deviceKind === 'laptop'
      ? {ios: 'laptopcomputer', android: 'laptop_mac', web: 'laptop_mac'} as const
      : {ios: 'desktopcomputer', android: 'desktop_windows', web: 'desktop_windows'} as const

  return (
    <View style={[styles.card, {backgroundColor: theme.backgroundElement}]}>
      <View style={styles.deviceRow}>
        <View style={styles.deviceIcon}>
          <SymbolView name={icon} size={27} tintColor={theme.text}/>
        </View>
        <View style={styles.deviceInfo}>
          <Text numberOfLines={1} style={[styles.deviceName, {color: theme.text}]}>{device.deviceName}</Text>
          <Text numberOfLines={1} style={[styles.deviceAddress, {color: theme.textSecondary}]}>
            {device.lastKnownAddress ?? '尚未记录地址'}
          </Text>
        </View>
      </View>
      <View style={styles.permissionRow}>
        <View style={styles.permissionTextContent}>
          <Text style={[styles.permissionLabel, {color: theme.text}]}>允许接收传输</Text>
          <Text style={[styles.permissionDescription, {color: theme.textSecondary}]}>仅影响此手机接收来自该设备的内容</Text>
        </View>
        <Switch
          accessibilityLabel={`允许接收 ${device.deviceName} 的传输`}
          onValueChange={onReceiveEnabledChange}
          thumbColor={device.receiveEnabled ? theme.text : theme.backgroundSelected}
          trackColor={{false: theme.backgroundSelected, true: '#7CCB92'}}
          value={device.receiveEnabled}
        />
      </View>
    </View>
  )
}

export default function TrustManagement() {
  const theme = useTheme()
  const [myDevice, setMyDevice] = useState<LocalDeviceInfo | null>(null)
  const [pairingSession, setPairingSession] = useState<PairingSession | null>(null)
  const devices = useTrustedDevicesStore((state) => state.devices)
  const loadTrustedDevices = useTrustedDevicesStore((state) => state.load)
  const setReceiveEnabled = useTrustedDevicesStore((state) => state.setReceiveEnabled)

  useEffect(() => {
    loadTrustedDevices()
  }, [loadTrustedDevices])

  useEffect(() => {
    let cancelled = false

    const loadMyDevice = async () => {
      const deviceName = ExpoDevice.deviceName?.trim() || ExpoDevice.modelName?.trim() || 'FlowDrop Mobile'
      const deviceId = await getDeviceId()
      let ipAddress: string | null = null

      if (Platform.OS === 'android') {
        try {
          ipAddress = (await getWifiIPv4BroadcastTargetAsync())?.address ?? null
        } catch (error) {
          console.warn('Unable to determine the local Wi-Fi IPv4 address.', error)
        }
      }

      if (!cancelled) setMyDevice({deviceId, deviceName, ipAddress})
    }

    void loadMyDevice().catch((error) => {
      console.warn('Unable to load the local device information.', error)
    })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadPairingSession = async () => {
      if (Platform.OS === 'web') return
      await mobilePairingService.start()
      const session = mobilePairingService.activeSession ?? await mobilePairingService.createSession()
      if (!cancelled) setPairingSession(session)
    }

    void loadPairingSession().catch((error) => {
      console.warn('Unable to start the local pairing session.', error)
    })

    return () => {
      cancelled = true
    }
  }, [])

  const refreshPairingCode = () => {
    void mobilePairingService.createSession()
      .then(setPairingSession)
      .catch((error) => console.warn('Unable to refresh the local pairing code.', error))
  }

  return (
    <View style={[styles.screen, {backgroundColor: theme.background}]}>
      <Header>
        <Header.Center>
          <Text style={[styles.headerTitle, {color: theme.text}]}>FlowDrop</Text>
        </Header.Center>
      </Header>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={[styles.sectionTitle, {color: theme.text}]}>我的设备</Text>
        <MyDeviceCard
          device={myDevice}
          onRefreshPairingCode={refreshPairingCode}
          pairingSession={pairingSession}
        />

        <Text style={[styles.sectionTitle, {color: theme.text}]}>已配对设备</Text>
        {devices.length === 0 ? (
          <Text style={[styles.emptyText, {color: theme.textSecondary}]}>暂无已配对设备</Text>
        ) : devices.map((device) => (
          <TrustedDeviceCard
            device={device}
            key={device.deviceId}
            onReceiveEnabledChange={(receiveEnabled) => setReceiveEnabled(device.deviceId, receiveEnabled)}
          />
        ))}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: {flex: 1},
  headerTitle: {fontSize: 23, fontWeight: '700'},
  content: {paddingBottom: 28, paddingHorizontal: PAGE_HORIZONTAL_PADDING, paddingTop: 8},
  sectionTitle: {fontSize: 20, fontWeight: '700', marginBottom: 18},
  emptyText: {fontSize: 15, textAlign: 'center'},
  card: {borderRadius: 8, marginBottom: 12, padding: 16},
  deviceRow: {alignItems: 'center', flexDirection: 'row'},
  deviceIcon: {
    alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 26,
    height: 52, justifyContent: 'center', width: 52
  },
  deviceInfo: {flex: 1, marginLeft: 13, minWidth: 0},
  deviceName: {fontSize: 17, fontWeight: '700'},
  deviceAddress: {fontSize: 14, marginTop: 5},
  details: {borderTopWidth: StyleSheet.hairlineWidth, marginTop: 17, paddingTop: 5},
  deviceDetail: {alignItems: 'center', flexDirection: 'row', minHeight: 37},
  deviceDetailLabel: {fontSize: 14, width: 74},
  deviceDetailValue: {flex: 1, fontSize: 14, textAlign: 'right'},
  pairingFooter: {alignItems: 'center', flexDirection: 'row', gap: 10, marginTop: 6},
  pairingHint: {flex: 1, fontSize: 12, lineHeight: 17},
  refreshCodeButton: {alignItems: 'center', borderRadius: 6, height: 32, justifyContent: 'center', width: 54},
  refreshCodeButtonPressed: {opacity: 0.76},
  refreshCodeButtonText: {fontSize: 13, fontWeight: '600'},
  permissionRow: {
    alignItems: 'center', flexDirection: 'row', marginTop: 18
  },
  permissionTextContent: {flex: 1, marginRight: 12},
  permissionLabel: {fontSize: 15, fontWeight: '600'},
  permissionDescription: {fontSize: 13, lineHeight: 18, marginTop: 3}
})

function formatPairingExpiry(expiresAt: number): string {
  return new Date(expiresAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
}

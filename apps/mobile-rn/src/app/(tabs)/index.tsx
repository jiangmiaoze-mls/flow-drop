import {useRouter} from 'expo-router'
import {SymbolView} from 'expo-symbols'
import {useCallback, useRef} from 'react'
import {FlatList, Pressable, StyleSheet, Text, View} from 'react-native'

import ConnectionBottomSheet, {type ConnectionBottomSheetRef} from '@/components/ConnectionBottomSheet'
import {DiscoveryPulse} from '@/components/DiscoveryPulse'
import {Header} from '@/components/Header'
import {PAGE_HORIZONTAL_PADDING} from '@/constants/layout'
import {useTheme} from '@/hooks/use-theme'
import type {Device} from '@/types/temp'

const DEVICES: Device[] = [
  {id: 'work-pc', name: 'WORK-PC', ip: '192.168.1.100', type: 'desktop', authorized: true},
  {id: 'win-office-x1', name: 'WIN-OFFICE-X1', ip: '192.168.1.105', type: 'laptop'},
  {id: 'mac-studio-design', name: 'MAC-STUDIO-DESIGN', ip: '192.168.1.112', type: 'laptop'},
  {id: 'mac-1-design', name: 'MAC-STUDIO-DESIGN', ip: '192.168.1.112', type: 'laptop'}
]

function HomeListHeader() {
  const theme = useTheme()

  return (
    <View style={styles.listHeader}>
      <View style={styles.discoverySection}>
        <DiscoveryPulse/>
        <Text style={[styles.discoveryText, {color: theme.textSecondary}]}>正在寻找局域网中的电脑...</Text>
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
        device.authorized && styles.authorizedCard
      ]}>
      <View style={styles.deviceIcon}>
        <SymbolView name={iconName} size={27} tintColor="#111111"/>
      </View>

      <View style={styles.deviceInfo}>
        <View style={styles.deviceNameRow}>
          <Text numberOfLines={1} style={[styles.deviceName, {color: theme.text}]}>{device.name}</Text>
          {device.authorized ? (
            <View style={styles.authorizedBadge}>
              <Text style={styles.authorizedText}>已授权</Text>
            </View>
          ) : null}
        </View>
        <Text style={[styles.deviceIp, {color: theme.textSecondary}]}>{device.ip}</Text>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${device.authorized ? '进入传输' : '连接'} ${device.name}`}
        onPress={() => onPress(device)}
        style={({pressed}) => [styles.actionButton, pressed && styles.actionButtonPressed]}>
        <Text style={styles.actionButtonText}>{device.authorized ? '传输' : '连接'}</Text>
      </Pressable>
    </View>
  )
}

export default function FindDevice() {
  const theme = useTheme()
  const connectionSheetRef = useRef<ConnectionBottomSheetRef>(null)
  const router = useRouter()

  const handleDevicePress = useCallback((device: Device) => {
    if (!device.authorized) {
      connectionSheetRef.current?.present()
      return
    }

    router.push({
      pathname: '/transmission',
      params: {
        authorized: device.authorized ? 'true' : 'false',
        id: device.id,
        ip: device.ip,
        name: device.name,
        type: device.type,
      },
    })
  }, [router])

  const handleConfirmConnection = useCallback((_code: string) => {
    connectionSheetRef.current?.dismiss()
  }, [])

  const renderDevice = useCallback(({item}: { item: Device }) => (
    <DeviceCard device={item} onPress={handleDevicePress}/>
  ), [handleDevicePress])

  return (
    <View style={[styles.screen, {backgroundColor: theme.background}]}>
      <Header>
        <Header.Center>
          <Text style={[styles.headerTitle, {color: theme.text}]}>FlowDrop</Text>
        </Header.Center>
      </Header>

      <FlatList
        contentContainerStyle={styles.contentContainer}
        data={DEVICES}
        ItemSeparatorComponent={DeviceSeparator}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={HomeListHeader}
        renderItem={renderDevice}
        showsVerticalScrollIndicator={false}
        style={styles.list}
      />

      {/* 极简调用的新组件 */}
      <ConnectionBottomSheet
        ref={connectionSheetRef}
        onConfirm={handleConfirmConnection}
      />
    </View>
  )
}

function DeviceSeparator() {
  return <View style={styles.separator}/>
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
  listHeader: {
    marginBottom: 24
  },
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
  }
})
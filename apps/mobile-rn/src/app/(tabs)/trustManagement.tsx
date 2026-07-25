import {SymbolView} from 'expo-symbols'
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native'

import {Header} from '@/components/Header'
import {PAGE_HORIZONTAL_PADDING} from '@/constants/layout'
import {useTheme} from '@/hooks/use-theme'

type TrustedDeviceCardProps = {
  name: string
  remainingDays?: number
  status: 'active' | 'expired'
}

const ACTIVE_DEVICE: TrustedDeviceCardProps = {
  name: 'WORK-PC',
  remainingDays: 25,
  status: 'active',
}

const EXPIRED_DEVICE: TrustedDeviceCardProps = {
  name: 'HOME-LAPTOP',
  status: 'expired',
}

function TrustedDeviceCard({name, remainingDays, status}: TrustedDeviceCardProps) {
  const theme = useTheme()
  const isActive = status === 'active'

  return (
    <View
      style={[
        styles.card,
        {backgroundColor: theme.backgroundElement},
        !isActive && styles.expiredCard,
      ]}>
      <View style={styles.deviceRow}>
        <View style={[styles.deviceIcon, !isActive && styles.expiredDeviceIcon]}>
          <SymbolView
            name={{ios: 'laptopcomputer', android: 'laptop_mac', web: 'laptop_mac'}}
            size={27}
            tintColor={isActive ? theme.text : '#B9BBC1'}
          />
        </View>

        <View style={styles.deviceInfo}>
          <Text
            numberOfLines={1}
            style={[
              styles.deviceName,
              {color: isActive ? theme.text : '#85878C'},
              !isActive && styles.expiredDeviceName,
            ]}>
            {name}
          </Text>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, isActive ? styles.activeDot : styles.expiredDot]}/>
            <Text style={[styles.statusText, {color: isActive ? theme.textSecondary : '#E26C6C'}]}>
              {isActive ? `授权剩余：${remainingDays}天` : '授权已过期，请重新配对'}
            </Text>
          </View>
        </View>
      </View>

      {isActive ? (
        <View style={styles.actions}>
          <ActionButton icon="arrow.left.arrow.right" label="传输操作"/>
          <ActionButton label="修改别名"/>
          <ActionButton destructive label="解除信任"/>
        </View>
      ) : null}
    </View>
  )
}

type ActionButtonProps = {
  destructive?: boolean
  icon?: 'arrow.left.arrow.right'
  label: string
}

function ActionButton({destructive = false, icon, label}: ActionButtonProps) {
  const theme = useTheme()

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({pressed}) => [
        styles.actionButton,
        {backgroundColor: destructive ? '#F8DFE2' : theme.background},
        pressed && styles.actionButtonPressed,
      ]}>
      {icon ? (
        <SymbolView
          name={{ios: icon, android: 'swap_horiz', web: 'swap_horiz'}}
          size={16}
          tintColor={theme.text}
        />
      ) : null}
      <Text style={[styles.actionText, icon && styles.actionTextWithIcon, {color: destructive ? '#E25D62' : theme.text}]}>{label}</Text>
    </Pressable>
  )
}

export default function TrustManagement() {
  const theme = useTheme()

  return (
    <View style={[styles.screen, {backgroundColor: theme.background}]}>
      <Header>
        <Header.Center>
          <Text style={[styles.headerTitle, {color: theme.text}]}>FlowDrop</Text>
        </Header.Center>
      </Header>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}>
        <Text style={[styles.sectionTitle, {color: theme.text}]}>已信任的电脑</Text>
        <TrustedDeviceCard {...ACTIVE_DEVICE}/>

        <Text style={[styles.sectionTitle, styles.expiredSectionTitle, {color: theme.text}]}>授权已过期</Text>
        <TrustedDeviceCard {...EXPIRED_DEVICE}/>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 23,
    fontWeight: '700',
  },
  content: {
    paddingBottom: 28,
    paddingHorizontal: PAGE_HORIZONTAL_PADDING,
    paddingTop: 8,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 18,
  },
  expiredSectionTitle: {
    marginTop: 30,
  },
  card: {
    borderRadius: 18,
    minHeight: 170,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  expiredCard: {
    alignItems: 'center',
    flexDirection: 'row',
    minHeight: 92,
    paddingBottom: 20,
  },
  deviceIcon: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 27,
    height: 54,
    justifyContent: 'center',
    width: 54,
  },
  expiredDeviceIcon: {
    backgroundColor: '#F9F9FA',
  },
  deviceRow: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  deviceInfo: {
    flex: 1,
    marginLeft: 14,
    minWidth: 0,
  },
  deviceName: {
    fontSize: 19,
    fontWeight: '700',
  },
  expiredDeviceName: {
    textDecorationLine: 'line-through',
  },
  statusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    marginTop: 5,
  },
  statusDot: {
    borderRadius: 5,
    height: 10,
    marginRight: 7,
    width: 10,
  },
  activeDot: {
    backgroundColor: '#28C66A',
  },
  expiredDot: {
    backgroundColor: '#E26C6C',
  },
  statusText: {
    fontSize: 15,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 24,
  },
  actionButton: {
    alignItems: 'center',
    borderRadius: 10,
    flex: 1,
    flexDirection: 'row',
    height: 46,
    justifyContent: 'center',
  },
  actionButtonPressed: {
    opacity: 0.7,
  },
  actionText: {
    fontSize: 15,
    fontWeight: '500',
  },
  actionTextWithIcon: {
    marginLeft: 5,
  },
})

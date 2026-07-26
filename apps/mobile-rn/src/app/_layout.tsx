import 'react-native-gesture-handler'

import {BottomSheetModalProvider} from '@gorhom/bottom-sheet'
import * as SplashScreen from 'expo-splash-screen'
import {GestureHandlerRootView} from 'react-native-gesture-handler'
import {Stack} from 'expo-router'
import {useAccessFineLocationPermission} from '@/hooks/usePermissions'
import {useEffect, useState} from 'react'
import {AppState, Modal, Platform, Pressable, StyleSheet, Text, View} from 'react-native'

import {useTheme} from '@/hooks/use-theme'
import {mobilePairingService, type MobilePairingRequest} from '@/network/mobilePairingService'
import {setTransferSecret} from '@/storage/transferCredentialRepository'
import {useTrustedDevicesStore} from '@/store/useTrustedDevicesStore'


void SplashScreen.preventAutoHideAsync()

function IncomingPairingDialog({
  request,
  onDecision
}: {
  request: MobilePairingRequest | null
  onDecision: (status: 'approved' | 'rejected') => void
}) {
  const theme = useTheme()

  return (
    <Modal animationType="fade" transparent visible={request !== null}>
      <View style={styles.pairingBackdrop}>
        <View accessibilityViewIsModal style={[styles.pairingDialog, {backgroundColor: theme.background}]}>
          <Text style={[styles.pairingTitle, {color: theme.text}]}>新的配对请求</Text>
          <Text style={[styles.pairingMessage, {color: theme.textSecondary}]}>“{request?.deviceName}”想与此手机配对。</Text>
          <Text numberOfLines={1} style={[styles.pairingDeviceId, {color: theme.textSecondary}]}>{request?.deviceId}</Text>
          <View style={styles.pairingActions}>
            <Pressable
              accessibilityLabel="拒绝配对"
              accessibilityRole="button"
              onPress={() => onDecision('rejected')}
              style={({pressed}) => [styles.rejectButton, {backgroundColor: theme.backgroundElement}, pressed && styles.buttonPressed]}>
              <Text style={[styles.rejectText, {color: theme.text}]}>拒绝</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="接受配对"
              accessibilityRole="button"
              onPress={() => onDecision('approved')}
              style={({pressed}) => [styles.approveButton, {backgroundColor: theme.text}, pressed && styles.buttonPressed]}>
              <Text style={[styles.approveText, {color: theme.background}]}>接受配对</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

export default function RootLayout() {
  const [isReady, setIsReady] = useState(false)
  const [incomingPairingRequest, setIncomingPairingRequest] = useState<MobilePairingRequest | null>(null)
  const {checkAccessFineLocationPermission} = useAccessFineLocationPermission()

  useEffect(() => {
    let isActive = true

    const initialize = async () => {
      try {
        await checkAccessFineLocationPermission()
      } finally {
        if (!isActive) return
        setIsReady(true)
        await SplashScreen.hideAsync()
      }
    }

    void initialize()

    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void checkAccessFineLocationPermission()
      }
    })

    return () => {
      isActive = false
      subscription.remove()
    }
  }, [checkAccessFineLocationPermission])

  useEffect(() => {
    if (Platform.OS === 'web') return

    let active = true
    const updatePendingRequest = () => {
      if (active) setIncomingPairingRequest(mobilePairingService.getPendingRequests()[0] ?? null)
    }
    const unsubscribe = mobilePairingService.subscribe(updatePendingRequest)

    void mobilePairingService.start()
      .then(updatePendingRequest)
      .catch((error) => console.warn('Unable to start the mobile pairing endpoint.', error))

    return () => {
      active = false
      unsubscribe()
      mobilePairingService.stop()
    }
  }, [])

  const handleIncomingPairingDecision = async (status: 'approved' | 'rejected') => {
    const request = incomingPairingRequest
    if (!request) return
    const resolvedRequest = mobilePairingService.resolvePairingRequest(request.requestId, status)
    if (status === 'approved' && resolvedRequest) {
      if (!resolvedRequest.transferSecret) return
      await setTransferSecret(resolvedRequest.deviceId, resolvedRequest.transferSecret)
      const now = Date.now()
      const existing = useTrustedDevicesStore.getState().devices.find((device) => device.deviceId === resolvedRequest.deviceId)
      useTrustedDevicesStore.getState().save({
        controlPort: 3000,
        deviceId: resolvedRequest.deviceId,
        deviceKind: resolvedRequest.deviceKind,
        deviceName: resolvedRequest.deviceName,
        lastKnownAddress: resolvedRequest.address || undefined,
        lastSeenAt: now,
        pairedAt: existing?.pairedAt ?? now,
        receiveEnabled: existing?.receiveEnabled ?? true,
        updatedAt: now
      })
    }
    setIncomingPairingRequest(mobilePairingService.getPendingRequests()[0] ?? null)
  }

  if (!isReady) {
    return null
  }

  return (
    <GestureHandlerRootView style={{flex: 1}}>
      <BottomSheetModalProvider>
        <Stack>
          <Stack.Screen name="(tabs)" options={{headerShown: false}}/>
          <Stack.Screen name="transmission" options={{headerShown: false}}/>
        </Stack>
        <IncomingPairingDialog request={incomingPairingRequest} onDecision={handleIncomingPairingDecision}/>
      </BottomSheetModalProvider>
    </GestureHandlerRootView>
  )
}

const styles = StyleSheet.create({
  pairingBackdrop: {alignItems: 'center', backgroundColor: 'rgba(0, 0, 0, 0.44)', flex: 1, justifyContent: 'center', padding: 24},
  pairingDialog: {borderRadius: 8, maxWidth: 420, padding: 20, width: '100%'},
  pairingTitle: {fontSize: 18, fontWeight: '700'},
  pairingMessage: {fontSize: 15, lineHeight: 22, marginTop: 10},
  pairingDeviceId: {fontSize: 12, marginTop: 6},
  pairingActions: {flexDirection: 'row', gap: 10, marginTop: 20},
  rejectButton: {alignItems: 'center', borderRadius: 6, flex: 1, height: 44, justifyContent: 'center'},
  approveButton: {alignItems: 'center', borderRadius: 6, flex: 1, height: 44, justifyContent: 'center'},
  rejectText: {fontSize: 15, fontWeight: '700'},
  approveText: {fontSize: 15, fontWeight: '700'},
  buttonPressed: {opacity: 0.76}
})

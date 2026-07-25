import 'react-native-gesture-handler'

import {BottomSheetModalProvider} from '@gorhom/bottom-sheet'
import * as SplashScreen from 'expo-splash-screen'
import {GestureHandlerRootView} from 'react-native-gesture-handler'
import {Stack} from 'expo-router'
import {useAccessFineLocationPermission} from '@/hooks/usePermissions'
import {useEffect, useState} from 'react'
import {AppState} from 'react-native'


void SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  const [isReady, setIsReady] = useState(false)
  const {checkAccessFineLocationPermission} = useAccessFineLocationPermission()

  useEffect(() => {
    const initialize = async () => {
      try {
        await checkAccessFineLocationPermission()
      } finally {
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

    return () => subscription.remove()
  }, [checkAccessFineLocationPermission])

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
      </BottomSheetModalProvider>
    </GestureHandlerRootView>
  )
}

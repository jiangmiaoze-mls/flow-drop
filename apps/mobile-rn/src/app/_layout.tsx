import 'react-native-gesture-handler'

import {BottomSheetModalProvider} from '@gorhom/bottom-sheet'
import * as SplashScreen from 'expo-splash-screen'
import {useColorScheme} from 'react-native'
import {GestureHandlerRootView} from 'react-native-gesture-handler'
import {Stack} from 'expo-router'
import {usePermissionsStore} from '@/store/usePermissionsStore'
import {useAccessFineLocationPermission} from '@/hooks/usePermissions'
import {useEffect, useState} from 'react'


void SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  const colorScheme = useColorScheme()
  const [isReady, setIsReady] = useState(false)

  const setAccessFineLocation = usePermissionsStore(state => state.setAccessFineLocation)
  const {checkAccessFineLocationPermission} = useAccessFineLocationPermission()

  const main = async () => {
    try {
      const permission = await checkAccessFineLocationPermission()
      setAccessFineLocation(permission)
    } finally {
      setIsReady(true)
      await SplashScreen.hideAsync()
    }
  }

  useEffect(() => {
    void main()
  }, [])

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

import 'react-native-gesture-handler'

import {BottomSheetModalProvider} from '@gorhom/bottom-sheet'
import * as SplashScreen from 'expo-splash-screen'
import {useColorScheme} from 'react-native'
import {GestureHandlerRootView} from 'react-native-gesture-handler'
import {Stack} from 'expo-router'


SplashScreen.preventAutoHideAsync()

export default function TabLayout() {
  const colorScheme = useColorScheme()
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

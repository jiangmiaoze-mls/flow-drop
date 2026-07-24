import * as SplashScreen from 'expo-splash-screen'
import {useColorScheme} from 'react-native'
import {Stack} from 'expo-router'


SplashScreen.preventAutoHideAsync()

export default function TabLayout() {
  const colorScheme = useColorScheme()
  return (
    <Stack>
      <Stack.Screen name="(tabs)" options={{headerShown: false}}/>
    </Stack>
  )
}

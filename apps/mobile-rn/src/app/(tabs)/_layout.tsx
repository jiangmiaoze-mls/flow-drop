import {Tabs} from 'expo-router'
import {SymbolView} from 'expo-symbols'
import {SafeAreaView} from 'react-native-safe-area-context'

import {useTheme} from '@/hooks/use-theme'

export default function TabsLayout() {
  const theme = useTheme()

  return (
    <SafeAreaView edges={['top']} style={{backgroundColor: theme.background, flex: 1}}>
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: theme.text,
          tabBarInactiveTintColor: theme.textSecondary,
          tabBarLabelStyle: {fontSize: 12, fontWeight: '600'},
          tabBarStyle: {
            backgroundColor: theme.background,
            borderTopColor: theme.backgroundElement,
            height: 64,
            paddingBottom: 7,
            paddingTop: 7,
          },
        }}>
        <Tabs.Screen
          name="index"
          options={{
            title: '发现设备',
            headerShown: false,
            tabBarIcon: ({color}) => (
              <SymbolView
                name={{ios: 'dot.radiowaves.left.and.right', android: 'radar', web: 'radar'}}
                size={23}
                tintColor={color}
              />
            ),
          }}/>
        <Tabs.Screen
          name="transmissionRecord"
          options={{
            title: '传输记录',
            headerShown: false,
            tabBarIcon: ({color}) => (
              <SymbolView
                name={{ios: 'clock.arrow.circlepath', android: 'history', web: 'history'}}
                size={23}
                tintColor={color}
              />
            ),
          }}/>
        <Tabs.Screen
          name="trustManagement"
          options={{
            title: '设备管理',
            headerShown: false,
            tabBarIcon: ({color}) => (
              <SymbolView
                name={{ios: 'desktopcomputer', android: 'desktop_windows', web: 'desktop_windows'}}
                size={23}
                tintColor={color}
              />
            ),
          }}/>
      </Tabs>
    </SafeAreaView>
  )
}

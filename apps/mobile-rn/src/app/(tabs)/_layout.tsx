import {Tabs} from 'expo-router'


export default function TabsLayout() {
  return (
    <Tabs>
      <Tabs.Screen name="index" options={{title: '发现设备', headerShown: false}}/>
      <Tabs.Screen name="transmissionRecord" options={{title: '传输记录', headerShown: false}}/>
      <Tabs.Screen name="trustManagement" options={{title: '信任管理', headerShown: false}}/>
    </Tabs>
  )
}
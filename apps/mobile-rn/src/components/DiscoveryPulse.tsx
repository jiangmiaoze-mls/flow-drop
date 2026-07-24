import {SymbolView} from 'expo-symbols'
import {useEffect} from 'react'
import {StyleSheet, View} from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'

const RIPPLE_DURATION = 2400
const RIPPLE_SIZE = 164

type PulseRingProps = {
  delay: number
}

function PulseRing({delay}: PulseRingProps) {
  const progress = useSharedValue(0)

  useEffect(() => {
    progress.value = withDelay(
      delay,
      withRepeat(
        withTiming(1, {
          duration: RIPPLE_DURATION,
          easing: Easing.out(Easing.quad),
        }),
        -1,
        false,
      ),
    )

    return () => cancelAnimation(progress)
  }, [delay, progress])

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.16, 1], [0, 0.2, 0]),
    transform: [{scale: interpolate(progress.value, [0, 1], [0.3, 1])}],
  }))

  return <Animated.View pointerEvents="none" style={[styles.ripple, animatedStyle]}/>
}

export function DiscoveryPulse() {
  return (
    <View accessibilityLabel="正在搜寻附近设备" style={styles.container}>
      <PulseRing delay={0}/>
      <PulseRing delay={RIPPLE_DURATION / 3}/>
      <PulseRing delay={(RIPPLE_DURATION / 3) * 2}/>
      <View style={styles.iconContainer}>
        <SymbolView
          name={{ios: 'desktopcomputer', android: 'devices', web: 'devices'}}
          size={24}
          tintColor="#FFFFFF"
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    height: RIPPLE_SIZE,
    justifyContent: 'center',
    width: RIPPLE_SIZE,
  },
  ripple: {
    backgroundColor: '#61D787',
    borderRadius: RIPPLE_SIZE / 2,
    height: RIPPLE_SIZE,
    position: 'absolute',
    width: RIPPLE_SIZE,
  },
  iconContainer: {
    alignItems: 'center',
    backgroundColor: '#111111',
    borderRadius: 25,
    height: 50,
    justifyContent: 'center',
    width: 50,
  },
})

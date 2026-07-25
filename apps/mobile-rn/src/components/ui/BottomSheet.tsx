import {forwardRef, useCallback, useImperativeHandle, useRef, useState} from 'react'
import {Animated, Dimensions, Easing, Modal, PanResponder, Pressable, StyleSheet, View} from 'react-native'


export type BottomSheetRef = {
  dismiss: () => void
  present: () => void
}

export type BottomSheetProps = {
  backgroundColor?: string
  children: React.ReactNode
  onDismiss?: () => void
}

const {height: SCREEN_HEIGHT} = Dimensions.get('window')

const BottomSheet = forwardRef<BottomSheetRef, BottomSheetProps>(function BottomSheet(
  {backgroundColor = '#FFFFFF', children, onDismiss},
  ref
) {
  const [visible, setVisible] = useState(false)

  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current
  const opacity = useRef(new Animated.Value(0)).current

  const dismiss = useCallback(() => {
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: SCREEN_HEIGHT,
        duration: 250,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true
      })
    ]).start(() => {
      setVisible(false)
      onDismiss?.()
    })
  }, [opacity, translateY, onDismiss])

  const present = useCallback(() => {
    setVisible(true)
    translateY.setValue(SCREEN_HEIGHT)
    opacity.setValue(0)

    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 0,
        duration: 350,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 350,
        useNativeDriver: true
      })
    ]).start()
  }, [opacity, translateY])

  useImperativeHandle(ref, () => ({dismiss, present}), [dismiss, present])

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, gestureState) => {
        return gestureState.dy > 2 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx)
      },
      onPanResponderMove: (_, gestureState) => {
        if (gestureState.dy > 0) {
          translateY.setValue(gestureState.dy)
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dy > 100 || gestureState.vy > 0.8) {
          dismiss()
        } else {
          Animated.spring(translateY, {
            toValue: 0,
            bounciness: 6,
            useNativeDriver: true
          }).start()
        }
      }
    })
  ).current

  return (
    <Modal
      animationType="none"
      hardwareAccelerated
      onRequestClose={dismiss}
      transparent
      visible={visible}>
      <Animated.View style={[styles.backdrop, {opacity}]}>
        <Pressable onPress={dismiss} style={StyleSheet.absoluteFill}/>
      </Animated.View>

      <View pointerEvents="box-none" style={styles.sheetContainer}>
        <Animated.View
          {...panResponder.panHandlers}
          style={[
            styles.sheetContent,
            {
              backgroundColor,
              transform: [{translateY}]
            }
          ]}>
          <View onStartShouldSetResponder={() => true}>
            {children}
          </View>
        </Animated.View>
      </View>
    </Modal>
  )
})

export default BottomSheet

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0, 0, 0, 0.38)'
  },
  sheetContainer: {
    flex: 1,
    justifyContent: 'flex-end'
  },
  sheetContent: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingBottom: 34,
    paddingTop: 22
  }
})
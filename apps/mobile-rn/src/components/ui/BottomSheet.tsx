import React, {
  createContext,
  forwardRef,
  type RefObject,
  useCallback,
  useContext,
  useImperativeHandle,
  useRef,
  useState
} from 'react'
import {
  Animated,
  Dimensions,
  Easing,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  PanResponder,
  Pressable,
  ScrollView,
  type ScrollViewProps,
  StyleSheet,
  View,
  type ViewStyle
} from 'react-native'

const { height: SCREEN_HEIGHT } = Dimensions.get('window')

type BottomSheetContextType = {
  translateY: Animated.Value
  dismiss: () => void
  isScrollAtTopRef: RefObject<boolean>
  // 新增：用于标记触摸是否发生在 ScrollView 内部
  touchFlagRef: RefObject<boolean>
}

const BottomSheetContext = createContext<BottomSheetContextType | null>(null)

export type BottomSheetRef = {
  dismiss: () => void
  present: () => void
}

export type BottomSheetProps = {
  backgroundColor?: string
  children: React.ReactNode
  maxHeight?: ViewStyle['height']
  onDismiss?: () => void
  contentStyle?: ViewStyle
}

const BottomSheetComponent = forwardRef<BottomSheetRef, BottomSheetProps>(
  function BottomSheet(
    {
      backgroundColor = '#FFFFFF',
      children,
      maxHeight = SCREEN_HEIGHT * 0.9,
      onDismiss,
      contentStyle
    },
    ref
  ) {
    const [visible, setVisible] = useState(false)
    const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current
    const opacity = useRef(new Animated.Value(0)).current
    const isScrollAtTopRef = useRef(true)
    const touchFlagRef = useRef(false)

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
      isScrollAtTopRef.current = true
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

    useImperativeHandle(ref, () => ({ dismiss, present }), [dismiss, present])

    // 外层 Pan 回归正常配置：绝不主动抢首个事件，只靠 Move 拦截，保护 ScrollView
    const panResponder = useRef(
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, gs) => {
          const isDown = gs.dy > 5 && Math.abs(gs.dy) > Math.abs(gs.dx)
          return isDown && isScrollAtTopRef.current
        },
        onPanResponderMove: (_, gs) => {
          if (gs.dy > 0) translateY.setValue(gs.dy)
        },
        onPanResponderRelease: (_, gs) => {
          if (gs.dy > 100 || gs.vy > 0.8) {
            dismiss()
          } else {
            Animated.spring(translateY, {
              toValue: 0,
              bounciness: 6,
              useNativeDriver: true
            }).start()
          }
        },
        onPanResponderTerminate: () => {
          Animated.spring(translateY, {
            toValue: 0,
            bounciness: 6,
            useNativeDriver: true
          }).start()
        }
      })
    ).current

    return (
      <Modal
        animationType="none"
        hardwareAccelerated
        onRequestClose={dismiss}
        transparent
        visible={visible}
      >
        <Animated.View style={[styles.backdrop, { opacity }]}>
          <Pressable onPress={dismiss} style={StyleSheet.absoluteFill} />
        </Animated.View>

        <View pointerEvents="box-none" style={styles.sheetContainer}>
          <BottomSheetContext.Provider
            value={{ translateY, dismiss, isScrollAtTopRef, touchFlagRef }}
          >
            <Animated.View
              {...panResponder.panHandlers}
              style={[
                styles.sheetContent,
                {
                  backgroundColor,
                  maxHeight,
                  transform: [{ translateY }]
                },
                contentStyle
              ]}
            >
              <View
                style={styles.contentContainer}
                // 【核心：智能识别】
                // 1. 在触摸刚按下的捕获阶段（最先执行），重置 Flag
                onStartShouldSetResponderCapture={() => {
                  touchFlagRef.current = false
                  return false
                }}
                // 2. 在事件冒泡阶段（最后执行），决定是否兜底
                onStartShouldSetResponder={() => {
                  // 如果为 true，说明子树中的 ScrollView 已经被摸到了，我们放弃接管，让它滚！
                  // 如果为 false，说明摸到的是纯文本/空白处，我们果断接管，防止手势死亡！
                  return !touchFlagRef.current
                }}
              >
                {children}
              </View>
            </Animated.View>
          </BottomSheetContext.Provider>
        </View>
      </Modal>
    )
  }
)

const BottomSheetScrollView = forwardRef<ScrollView, ScrollViewProps>(
  function BottomSheetScrollView(props, ref) {
    const context = useContext(BottomSheetContext)
    const scrollRef = useRef<ScrollView>(null)
    const startY = useRef(0)
    const isDraggingSheet = useRef(false)
    const currentOffsetY = useRef(0)
    const startedAtTop = useRef(false)

    React.useImperativeHandle(ref, () => scrollRef.current as any)

    const updateIsAtTop = (y: number) => {
      currentOffsetY.current = y
      if (!isDraggingSheet.current && context) {
        context.isScrollAtTopRef.current = y <= 1
      }
    }

    const handleScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      updateIsAtTop(e.nativeEvent.contentOffset.y)
      props.onScroll?.(e)
    }

    const onTouchStart = (e: any) => {
      startY.current = e.nativeEvent.pageY
      isDraggingSheet.current = false

      startedAtTop.current = currentOffsetY.current <= 1
      if (startedAtTop.current) {
        scrollRef.current?.setNativeProps({ scrollEnabled: false })
        if (context) context.isScrollAtTopRef.current = true
      }

      props.onTouchStart?.(e)
    }

    const onTouchMove = (e: any) => {
      if (!context) {
        props.onTouchMove?.(e)
        return
      }

      const dy = e.nativeEvent.pageY - startY.current

      if (isDraggingSheet.current) {
        context.translateY.setValue(Math.max(0, dy))
      } else if (startedAtTop.current) {
        if (dy > 0) {
          isDraggingSheet.current = true
          context.translateY.setValue(dy)
        } else if (dy < -2) {
          startedAtTop.current = false
          scrollRef.current?.setNativeProps({ scrollEnabled: true })
        }
      }

      props.onTouchMove?.(e)
    }

    const endDrag = (dy: number) => {
      scrollRef.current?.setNativeProps({ scrollEnabled: true })
      startedAtTop.current = false

      if (!isDraggingSheet.current || !context) return

      isDraggingSheet.current = false

      if (dy > 100) {
        context.dismiss()
      } else {
        Animated.spring(context.translateY, {
          toValue: 0,
          bounciness: 6,
          useNativeDriver: true
        }).start()
      }
    }

    const onTouchEnd = (e: any) => {
      endDrag(e.nativeEvent.pageY - startY.current)
      props.onTouchEnd?.(e)
    }

    const onTouchCancel = (e: any) => {
      endDrag(e.nativeEvent.pageY - startY.current)
      props.onTouchCancel?.(e)
    }

    return (
      <View
        style={styles.scrollViewWrapper}
        // 【核心：智能反馈】
        // 当触摸进入 ScrollView 的地盘时，拦截捕获阶段并打上标记告诉父组件：“别抢！这是我的！”
        onStartShouldSetResponderCapture={() => {
          if (context) context.touchFlagRef.current = true
          return false
        }}
      >
        <ScrollView
          ref={scrollRef}
          bounces={false}
          nestedScrollEnabled
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
          {...props}
          onScroll={handleScroll}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchCancel}
          style={[styles.innerScrollView, props.style]}
        />
      </View>
    )
  }
)

const BottomSheet = Object.assign(BottomSheetComponent, {
  ScrollView: BottomSheetScrollView
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
  },
  contentContainer: {
    flexShrink: 1,
    paddingBottom: 34,
    paddingTop: 22, // 维持在这里，确保顶部空白也能被父容器兜底
  },
  scrollViewWrapper: {
    flexShrink: 1
  },
  innerScrollView: {
    flexShrink: 1
  }
})
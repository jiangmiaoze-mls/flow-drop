import {
  ANIMATION_SOURCE,
  GESTURE_SOURCE,
  useBottomSheetInternal,
  type GestureEventHandlerCallbackType,
  type GestureEventsHandlersHookType,
} from '@gorhom/bottom-sheet'
import {useCallback} from 'react'
import {useSharedValue} from 'react-native-reanimated'

const MAX_DRAG_PREVIEW = 16
const CLOSE_DISTANCE = 96
const CLOSE_VELOCITY = 900
const DRAG_RESISTANCE = 0.2

export const useStableBottomSheetGesture: GestureEventsHandlersHookType = () => {
  const {
    animatedDetentsState,
    animatedPosition,
    animateToPosition,
    stopAnimation,
  } = useBottomSheetInternal()
  const initialPosition = useSharedValue(0)

  const handleOnStart: GestureEventHandlerCallbackType = useCallback(() => {
    'worklet'
    stopAnimation()
    initialPosition.value = animatedPosition.value
  }, [animatedPosition, initialPosition, stopAnimation])

  const handleOnChange: GestureEventHandlerCallbackType = useCallback((source, event) => {
    'worklet'
    if (source !== GESTURE_SOURCE.HANDLE) {
      return
    }

    const downwardDistance = Math.max(0, event.translationY)
    const previewDistance = Math.min(
      downwardDistance * DRAG_RESISTANCE,
      MAX_DRAG_PREVIEW,
    )
    animatedPosition.value = initialPosition.value + previewDistance
  }, [animatedPosition, initialPosition])

  const handleOnEnd: GestureEventHandlerCallbackType = useCallback((source, event) => {
    'worklet'
    if (source !== GESTURE_SOURCE.HANDLE) {
      return
    }

    const {closedDetentPosition, highestDetentPosition} = animatedDetentsState.get()
    if (closedDetentPosition === undefined || highestDetentPosition === undefined) {
      return
    }

    const shouldClose = event.translationY >= CLOSE_DISTANCE || event.velocityY >= CLOSE_VELOCITY
    animateToPosition(
      shouldClose ? closedDetentPosition : highestDetentPosition,
      ANIMATION_SOURCE.GESTURE,
      shouldClose ? Math.max(0, event.velocityY) / 2 : 0,
    )
  }, [animateToPosition, animatedDetentsState])

  const handleOnFinalize: GestureEventHandlerCallbackType = useCallback(() => {
    'worklet'
    const {highestDetentPosition} = animatedDetentsState.get()
    if (highestDetentPosition === undefined) {
      return
    }

    animateToPosition(highestDetentPosition, ANIMATION_SOURCE.GESTURE, 0)
  }, [animateToPosition, animatedDetentsState])

  return {
    handleOnStart,
    handleOnChange,
    handleOnEnd,
    handleOnFinalize,
  }
}

import {
  BottomSheetBackdrop,
  type BottomSheetBackdropProps,
  BottomSheetModal,
  BottomSheetTextInput,
  BottomSheetView
} from '@gorhom/bottom-sheet'
import {SymbolView} from 'expo-symbols'
import {forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState} from 'react'
import {BackHandler, Keyboard, Pressable, StyleSheet, Text, View} from 'react-native'

import {PAGE_HORIZONTAL_PADDING} from '@/constants/layout'
import {useStableBottomSheetGesture} from '@/hooks/use-stable-bottom-sheet-gesture'
import {useTheme} from '@/hooks/use-theme'


export type TextDeliveryBottomSheetRef = {
  dismiss: () => void
  present: () => void
}

type TextDeliveryBottomSheetProps = {
  onSubmit?: (text: string) => void
  targetName: string
}

const TextDeliveryBottomSheet = forwardRef<
  TextDeliveryBottomSheetRef,
  TextDeliveryBottomSheetProps
>(function TextDeliveryBottomSheet({onSubmit, targetName}, ref) {
  const theme = useTheme()
  const bottomSheetRef = useRef<BottomSheetModal>(null)
  const isMountedRef = useRef(false)
  const [text, setText] = useState('')
  const [isPresented, setIsPresented] = useState(false)
  const canSubmit = text.trim().length > 0

  // 用于追踪键盘当前的可见状态
  const isKeyboardVisibleRef = useRef(false)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  // 监听键盘弹起与收起事件
  useEffect(() => {
    const showSubscription = Keyboard.addListener('keyboardDidShow', () => {
      isKeyboardVisibleRef.current = true
    })
    const hideSubscription = Keyboard.addListener('keyboardDidHide', () => {
      isKeyboardVisibleRef.current = false
    })

    return () => {
      showSubscription.remove()
      hideSubscription.remove()
    }
  }, [])

  const present = useCallback(() => {
    if (!isMountedRef.current) return
    setIsPresented(true)
    bottomSheetRef.current?.present()
  }, [])

  const dismiss = useCallback(() => {
    Keyboard.dismiss()
    bottomSheetRef.current?.dismiss()
  }, [])

  useImperativeHandle(ref, () => ({dismiss, present}), [dismiss, present])

  useEffect(() => {
    if (!isPresented) {
      return
    }

    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      dismiss()
      return true
    })

    return () => subscription.remove()
  }, [dismiss, isPresented])

  const handleDismiss = useCallback(() => {
    Keyboard.dismiss()
    if (isMountedRef.current) setIsPresented(false)
  }, [])

  const handleSubmit = useCallback(() => {
    const content = text.trim()
    if (!content) {
      return
    }

    onSubmit?.(content)
    setText('')
    dismiss()
  }, [dismiss, onSubmit, text])

  const renderBackdrop = useCallback((props: BottomSheetBackdropProps) => (
    <BottomSheetBackdrop
      {...props}
      appearsOnIndex={0}
      disappearsOnIndex={-1}
      opacity={0.38}
      // 禁用组件内置的无脑关闭行为
      pressBehavior="none"
    >
      {/* 核心修复：用一个占满背景的 Pressable 自己接管点击逻辑，绕过内置组件被禁用 onPress 的 bug */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={() => {
          if (isKeyboardVisibleRef.current) {
            Keyboard.dismiss() // 键盘存在时，仅收起键盘
          } else {
            dismiss() // 键盘不在时，保留点击背景关闭弹窗的功能
          }
        }}
      />
    </BottomSheetBackdrop>
  ), [dismiss])

  return (
    <BottomSheetModal
      android_keyboardInputMode="adjustPan"
      backdropComponent={renderBackdrop}
      backgroundStyle={{backgroundColor: theme.background}}
      enableBlurKeyboardOnGesture
      enableContentPanningGesture={false}
      enableDismissOnClose
      enableDynamicSizing
      enableHandlePanningGesture
      handleComponent={() => null}
      enableOverDrag={false}
      enablePanDownToClose={false}
      gestureEventsHandlersHook={useStableBottomSheetGesture}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      onDismiss={handleDismiss}
      ref={bottomSheetRef}
    >
      <BottomSheetView>
        <Pressable
          accessible={false}
          onPress={Keyboard.dismiss} // 内部：点击内容空白处仅收起键盘
          style={styles.content}>
          <BottomSheetTextInput
            accessibilityLabel="投递文字内容"
            multiline
            onChangeText={setText}
            placeholder="在此输入或粘贴文字..."
            placeholderTextColor={theme.textSecondary}
            selectionColor={theme.text}
            style={[
              styles.input,
              {
                backgroundColor: theme.backgroundElement,
                color: theme.text
              }
            ]}
            textAlignVertical="top"
            value={text}
          />

          <View style={styles.targetRow}>
            <View style={styles.targetIcon}>
              <SymbolView
                name={{ios: 'laptopcomputer', android: 'computer', web: 'computer'}}
                size={20}
                tintColor="#FFFFFF"
              />
            </View>
            <Text style={[styles.targetLabel, {color: theme.textSecondary}]}>正在投递至</Text>
            <Text numberOfLines={1} style={[styles.targetName, {color: theme.text}]}>{targetName}</Text>
          </View>

          <Pressable
            accessibilityLabel={`立即投递文字至 ${targetName}`}
            accessibilityRole="button"
            accessibilityState={{disabled: !canSubmit}}
            disabled={!canSubmit}
            onPress={handleSubmit}
            style={({pressed}) => [
              styles.submitButton,
              !canSubmit && {backgroundColor: theme.backgroundSelected},
              pressed && styles.submitButtonPressed
            ]}>
            <Text
              style={[
                styles.submitText,
                !canSubmit && {color: theme.textSecondary}
              ]}>
              立即投递
            </Text>
            <SymbolView
              name={{ios: 'paperplane.fill', android: 'send', web: 'send'}}
              size={17}
              tintColor={canSubmit ? '#FFFFFF' : theme.textSecondary}
            />
          </Pressable>
        </Pressable>
      </BottomSheetView>
    </BottomSheetModal>
  )
})

export default TextDeliveryBottomSheet

const styles = StyleSheet.create({
  content: {
    paddingVertical: 20,
    paddingHorizontal: PAGE_HORIZONTAL_PADDING
  },
  input: {
    borderRadius: 16,
    fontSize: 16,
    height: 176,
    lineHeight: 23,
    paddingHorizontal: 18,
    paddingVertical: 16
  },
  targetRow: {
    alignItems: 'center',
    flexDirection: 'row',
    height: 54
  },
  targetIcon: {
    alignItems: 'center',
    backgroundColor: '#202020',
    borderRadius: 7,
    height: 28,
    justifyContent: 'center',
    width: 28
  },
  targetLabel: {
    fontSize: 13,
    marginLeft: 10
  },
  targetName: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    marginLeft: 4
  },
  submitButton: {
    alignItems: 'center',
    backgroundColor: '#050505',
    borderRadius: 8,
    flexDirection: 'row',
    gap: 9,
    height: 58,
    justifyContent: 'center'
  },
  submitButtonPressed: {
    opacity: 0.78
  },
  submitText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700'
  }
})

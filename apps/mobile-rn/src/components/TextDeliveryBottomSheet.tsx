import {
  BottomSheetBackdrop,
  type BottomSheetBackdropProps,
  BottomSheetModal,
  BottomSheetTextInput,
  BottomSheetView
} from '@gorhom/bottom-sheet'
import {SymbolView} from 'expo-symbols'
import {forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState} from 'react'
import {BackHandler, Keyboard, Pressable, StyleSheet, Text} from 'react-native'
import {PAGE_HORIZONTAL_PADDING} from '@/constants/layout'
import {useStableBottomSheetGesture} from '@/hooks/use-stable-bottom-sheet-gesture'
import {useTheme} from '@/hooks/use-theme'
import {TextInput} from 'react-native-gesture-handler'


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
  const inputRef = useRef<TextInput>(null)
  const isMountedRef = useRef(false)
  const [text, setText] = useState('')
  const [isPresented, setIsPresented] = useState(false)
  const canSubmit = text.trim().length > 0
  const isKeyboardVisibleRef = useRef(false)

  const onChange = (index: number) => {
    if (index === 0) {
      requestAnimationFrame(() => {
       inputRef.current?.focus()
      })
    }
  }

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

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
      pressBehavior="none"
    >
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={() => {
          if (isKeyboardVisibleRef.current) {
            Keyboard.dismiss()
          } else {
            dismiss()
          }
        }}
      />
    </BottomSheetBackdrop>
  ), [dismiss])

  return (
    <BottomSheetModal
      onChange={onChange}
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
            ref={inputRef}
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
    paddingHorizontal: PAGE_HORIZONTAL_PADDING,
    gap: 20
  },
  input: {
    borderRadius: 16,
    fontSize: 16,
    height: 176,
    lineHeight: 23,
    paddingHorizontal: 18,
    paddingVertical: 16
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

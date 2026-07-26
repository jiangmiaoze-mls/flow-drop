import {Modal, Pressable, StyleSheet, Text, View} from 'react-native'

import {useTheme} from '@/hooks/use-theme'

type BasicAlertDialogProps = {
  confirmText?: string
  message: string
  onConfirm: () => void
  title: string
  visible: boolean
}

export function BasicAlertDialog({
  confirmText = '知道了',
  message,
  onConfirm,
  title,
  visible
}: BasicAlertDialogProps) {
  const theme = useTheme()

  return (
    <Modal
      animationType="fade"
      onRequestClose={onConfirm}
      statusBarTranslucent
      transparent
      visible={visible}>
      <View style={styles.backdrop}>
        <View accessibilityViewIsModal style={[styles.dialog, {backgroundColor: theme.background}]}>
          <Text style={[styles.title, {color: theme.text}]}>{title}</Text>
          <Text style={[styles.message, {color: theme.textSecondary}]}>{message}</Text>

          <Pressable
            accessibilityLabel={confirmText}
            accessibilityRole="button"
            onPress={onConfirm}
            style={({pressed}) => [
              styles.confirmButton,
              {backgroundColor: theme.text},
              pressed && styles.confirmButtonPressed
            ]}>
            <Text style={[styles.confirmText, {color: theme.background}]}>{confirmText}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.44)',
    flex: 1,
    justifyContent: 'center',
    padding: 24
  },
  dialog: {
    borderRadius: 8,
    maxWidth: 420,
    padding: 20,
    width: '100%'
  },
  title: {
    fontSize: 18,
    fontWeight: '700'
  },
  message: {
    fontSize: 15,
    lineHeight: 22,
    marginTop: 10
  },
  confirmButton: {
    alignItems: 'center',
    borderRadius: 6,
    height: 44,
    justifyContent: 'center',
    marginTop: 20
  },
  confirmButtonPressed: {
    opacity: 0.76
  },
  confirmText: {
    fontSize: 15,
    fontWeight: '700'
  }
})

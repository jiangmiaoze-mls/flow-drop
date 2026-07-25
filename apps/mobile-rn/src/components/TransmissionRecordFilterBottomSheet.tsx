import {SymbolView, type SymbolViewProps} from 'expo-symbols'
import {forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState} from 'react'
import {Pressable, StyleSheet, Text, View} from 'react-native'
import BottomSheet, {type BottomSheetRef} from './ui/BottomSheet'
import {PAGE_HORIZONTAL_PADDING} from '@/constants/layout'
import {useTheme} from '@/hooks/use-theme'


export type TransmissionRecordFileType = 'document' | 'image' | 'link' | 'text' | 'video'
type FileType = 'all' | TransmissionRecordFileType
type SelectableFileType = TransmissionRecordFileType
type TransferStatus = 'all' | 'failed' | 'success'
type SelectableTransferStatus = Exclude<TransferStatus, 'all'>

export type TransmissionRecordFilter = {
  fileTypes: SelectableFileType[]
  statuses: SelectableTransferStatus[]
}

export type TransmissionRecordFilterBottomSheetRef = {
  dismiss: () => void
  present: () => void
}

type TransmissionRecordFilterBottomSheetProps = {
  onApply: (filter: TransmissionRecordFilter) => void
  value: TransmissionRecordFilter
}

type FileTypeOption = {
  icon: SymbolViewProps['name']
  label: string
  value: FileType
}

const createDefaultFilter = (): TransmissionRecordFilter => ({fileTypes: [], statuses: []})

export const TRANSMISSION_RECORD_FILE_TYPE_ICONS: Record<
  TransmissionRecordFileType,
  SymbolViewProps['name']
> = {
  image: {ios: 'photo', android: 'image', web: 'image'},
  video: {ios: 'video', android: 'videocam', web: 'videocam'},
  document: {ios: 'doc.text', android: 'description', web: 'description'},
  link: {ios: 'link', android: 'link', web: 'link'},
  text: {ios: 'textformat', android: 'text_fields', web: 'text_fields'}
}

const FILE_TYPE_OPTIONS: FileTypeOption[] = [
  {icon: {ios: 'square.grid.2x2', android: 'apps', web: 'apps'}, label: '全部', value: 'all'},
  {icon: TRANSMISSION_RECORD_FILE_TYPE_ICONS.image, label: '图片', value: 'image'},
  {icon: TRANSMISSION_RECORD_FILE_TYPE_ICONS.video, label: '视频', value: 'video'},
  {icon: TRANSMISSION_RECORD_FILE_TYPE_ICONS.document, label: '文档', value: 'document'},
  {icon: TRANSMISSION_RECORD_FILE_TYPE_ICONS.link, label: '链接', value: 'link'},
  {icon: TRANSMISSION_RECORD_FILE_TYPE_ICONS.text, label: '文本', value: 'text'}
]

const STATUS_OPTIONS: Array<{ label: string, value: TransferStatus }> = [
  {label: '全部', value: 'all'},
  {label: '成功', value: 'success'},
  {label: '失败', value: 'failed'}
]

const TransmissionRecordFilterBottomSheet = forwardRef<
  TransmissionRecordFilterBottomSheetRef,
  TransmissionRecordFilterBottomSheetProps
>(function TransmissionRecordFilterBottomSheet({onApply, value}, ref) {
  const theme = useTheme()
  const bottomSheetRef = useRef<BottomSheetRef>(null)
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    setDraft(value)
  }, [value])

  const dismiss = useCallback(() => {
    bottomSheetRef.current?.dismiss()
  }, [])

  const present = useCallback(() => {
    setDraft(value)
    bottomSheetRef.current?.present()
  }, [value])

  useImperativeHandle(ref, () => ({dismiss, present}), [dismiss, present])

  const handleApply = useCallback(() => {
    onApply(draft)
    dismiss()
  }, [dismiss, draft, onApply])

  const handleReset = useCallback(() => {
    onApply(createDefaultFilter())
    dismiss()
  }, [dismiss, onApply])

  const toggleFileType = useCallback((fileType: FileType) => {
    setDraft((current) => {
      if (fileType === 'all') {
        return {...current, fileTypes: []}
      }

      const fileTypes = current.fileTypes.includes(fileType)
        ? current.fileTypes.filter((v) => v !== fileType)
        : [...current.fileTypes, fileType]

      return {...current, fileTypes}
    })
  }, [])

  const toggleStatus = useCallback((status: TransferStatus) => {
    setDraft((current) => {
      if (status === 'all') {
        return {...current, statuses: []}
      }

      const statuses = current.statuses.includes(status)
        ? current.statuses.filter((v) => v !== status)
        : [...current.statuses, status]

      return {...current, statuses}
    })
  }, [])

  return (
    <BottomSheet backgroundColor={theme.background} ref={bottomSheetRef}>
      <View style={styles.mainContent}>
        <Text style={[styles.sectionLabel, {color: theme.textSecondary}]}>文件类型</Text>
        <View style={styles.fileTypeGrid}>
          {FILE_TYPE_OPTIONS.map((option) => {
            const active =
              option.value === 'all'
                ? draft.fileTypes.length === 0
                : draft.fileTypes.includes(option.value)

            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{selected: active}}
                key={option.value}
                onPress={() => toggleFileType(option.value)}
                style={({pressed}) => [
                  styles.fileTypeOption,
                  {backgroundColor: active ? '#050505' : theme.backgroundElement},
                  pressed && styles.pressed
                ]}>
                <SymbolView
                  name={option.icon}
                  size={22}
                  tintColor={active ? '#FFFFFF' : theme.textSecondary}
                />
                <Text style={[styles.fileTypeText, {color: active ? '#FFFFFF' : theme.text}]}>
                  {option.label}
                </Text>
              </Pressable>
            )
          })}
        </View>

        <Text style={[styles.sectionLabel, styles.statusLabel, {color: theme.textSecondary}]}>
          传输状态
        </Text>
        <View style={styles.statusOptions}>
          {STATUS_OPTIONS.map((option) => {
            const active =
              option.value === 'all'
                ? draft.statuses.length === 0
                : draft.statuses.includes(option.value)

            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{selected: active}}
                key={option.value}
                onPress={() => toggleStatus(option.value)}
                style={({pressed}) => [
                  styles.statusOption,
                  {backgroundColor: active ? '#050505' : theme.backgroundElement},
                  pressed && styles.pressed
                ]}>
                <Text style={[styles.statusText, {color: active ? '#FFFFFF' : theme.text}]}>
                  {option.label}
                </Text>
              </Pressable>
            )
          })}
        </View>
      </View>

      <View style={[styles.actions, {borderTopColor: theme.backgroundElement}]}>
        <Pressable
          accessibilityRole="button"
          onPress={handleApply}
          style={({pressed}) => [styles.applyButton, pressed && styles.pressed]}>
          <Text style={styles.applyText}>应用</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={handleReset}
          style={({pressed}) => [
            styles.resetButton,
            {backgroundColor: theme.backgroundElement},
            pressed && styles.pressed
          ]}>
          <Text style={[styles.resetText, {color: theme.text}]}>重置</Text>
        </Pressable>
      </View>
    </BottomSheet>
  )
})

export default TransmissionRecordFilterBottomSheet

const styles = StyleSheet.create({
  mainContent: {
    paddingHorizontal: PAGE_HORIZONTAL_PADDING
  },
  sectionLabel: {
    fontSize: 15,
    fontWeight: '600'
  },
  fileTypeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 10
  },
  fileTypeOption: {
    alignItems: 'center',
    borderRadius: 14,
    flexDirection: 'row',
    gap: 12,
    height: 56,
    paddingHorizontal: 18,
    width: '48%'
  },
  fileTypeText: {
    fontSize: 17,
    fontWeight: '600'
  },
  statusLabel: {
    marginTop: 22
  },
  statusOptions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10
  },
  statusOption: {
    alignItems: 'center',
    borderRadius: 28,
    height: 54,
    justifyContent: 'center',
    paddingHorizontal: 26
  },
  statusText: {
    fontSize: 17,
    fontWeight: '600'
  },
  actions: {
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: 10,
    paddingHorizontal: PAGE_HORIZONTAL_PADDING,
    paddingTop: 16
  },
  applyButton: {
    alignItems: 'center',
    backgroundColor: '#050505',
    borderRadius: 12,
    height: 58,
    justifyContent: 'center'
  },
  applyText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700'
  },
  resetButton: {
    alignItems: 'center',
    borderRadius: 12,
    height: 48,
    justifyContent: 'center',
    marginTop: 10
  },
  resetText: {
    fontSize: 17,
    fontWeight: '600'
  },
  pressed: {
    opacity: 0.7
  }
})

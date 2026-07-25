import {SymbolView, type SymbolViewProps} from 'expo-symbols'
import {forwardRef, ReactNode, useCallback, useImperativeHandle, useRef, useState} from 'react'
import {Pressable, StyleSheet, Text, View} from 'react-native'

import {
  TRANSMISSION_RECORD_FILE_TYPE_ICONS,
  type TransmissionRecordFileType
} from '@/components/TransmissionRecordFilterBottomSheet'
import BottomSheet, {type BottomSheetRef} from '@/components/ui/BottomSheet'
import {PAGE_HORIZONTAL_PADDING} from '@/constants/layout'
import {useTheme} from '@/hooks/use-theme'


type TransmissionDirection = 'receive' | 'send'
type TransmissionStatus = 'interrupted' | 'success'

const PHONE_ICON: SymbolViewProps['name'] = {
  ios: 'iphone',
  android: 'smartphone',
  web: 'smartphone'
}

const LAPTOP_ICON: SymbolViewProps['name'] = {
  ios: 'laptopcomputer',
  android: 'laptop_mac',
  web: 'laptop_mac'
}

export type TransmissionRecordDetail = {
  dateLabel: string
  detail: string
  direction: TransmissionDirection
  fileType: TransmissionRecordFileType
  id: string
  name: string
  status: TransmissionStatus
  time: string
}

export type TransmissionRecordDetailBottomSheetRef = {
  dismiss: () => void
  present: (record: TransmissionRecordDetail) => void
}

type TransmissionRecordDetailBottomSheetProps = {
  onDelete?: (record: TransmissionRecordDetail) => void
  onOpenFolder?: (record: TransmissionRecordDetail) => void
  onShare?: (record: TransmissionRecordDetail) => void
}

const TransmissionRecordDetailBottomSheet = forwardRef<
  TransmissionRecordDetailBottomSheetRef,
  TransmissionRecordDetailBottomSheetProps
>(function TransmissionRecordDetailBottomSheet({onDelete, onOpenFolder, onShare}, ref) {
  const theme = useTheme()
  const bottomSheetRef = useRef<BottomSheetRef>(null)
  const [record, setRecord] = useState<TransmissionRecordDetail | null>(null)

  const dismiss = useCallback(() => {
    bottomSheetRef.current?.dismiss()
  }, [])

  const present = useCallback((nextRecord: TransmissionRecordDetail) => {
    setRecord(nextRecord)
    bottomSheetRef.current?.present()
  }, [])

  useImperativeHandle(ref, () => ({dismiss, present}), [dismiss, present])

  if (!record) {
    return <BottomSheet ref={bottomSheetRef}>{null}</BottomSheet>
  }

  const isSuccess = record.status === 'success'
  const isSent = record.direction === 'send'
  const senderName = isSent ? 'My iPhone 15' : 'MacBook Pro'
  const receiverName = isSent ? 'MacBook Pro' : 'My iPhone 15'
  const senderIcon = isSent ? PHONE_ICON : LAPTOP_ICON
  const receiverIcon = isSent ? LAPTOP_ICON : PHONE_ICON

  return (
    <BottomSheet
      backgroundColor={theme.background}
      maxHeight="70%"
      contentStyle={{paddingBottom: 0}}
      ref={bottomSheetRef}
    >
      <BottomSheet.ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.fileSummary}>
          <View style={[styles.fileIcon, {backgroundColor: theme.backgroundElement}]}>
            <SymbolView
              name={TRANSMISSION_RECORD_FILE_TYPE_ICONS[record.fileType]}
              size={50}
              tintColor={theme.text}
            />
          </View>
          {isSuccess ?
            <View style={styles.successBadge}><SymbolView name={{ios: 'checkmark', android: 'check', web: 'check'}}
                                                          size={15}
                                                          tintColor="#FFFFFF"/></View> : null}
          <Text numberOfLines={1} style={[styles.fileName, {color: theme.text}]}>{record.name}</Text>
          <View style={styles.fileMetaRow}>
            <Text style={[styles.fileMeta, {color: theme.textSecondary}]}>{record.detail}</Text>
            <Text style={[styles.metaDot, {color: theme.textSecondary}]}>•</Text>
            <Text style={[styles.fileMeta, {color: theme.textSecondary}]}>{record.dateLabel} {record.time}</Text>
          </View>
        </View>

        <View style={[styles.routeCard, {backgroundColor: theme.backgroundElement}]}>
          <Participant icon={senderIcon} label="发送端" name={senderName} textColor={theme.text}/>
          <View style={styles.routeDirection}>
            <View style={styles.routeLine}>
              <View style={styles.routeDot}/>
            </View>
            <SymbolView name={{ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right'}}
                        size={20}
                        tintColor="#29C967"/>
          </View>
          <Participant icon={receiverIcon} label="接收端" name={receiverName} textColor={theme.text}/>
        </View>

        <View style={styles.detailList}>
          <DetailRow label="当前状态">
            <View style={styles.statusValue}>
              <View style={[styles.statusDot, {backgroundColor: isSuccess ? '#2DC866' : '#F04449'}]}/>
              <Text style={[styles.statusText, {color: isSuccess ? '#168A43' : '#E5484D'}]}>
                {isSuccess ? '传输成功' : '传输中断'}
              </Text>
            </View>
          </DetailRow>
          <DetailRow label="保存位置" last>
            <Text numberOfLines={2}
                  style={[styles.locationText, {color: theme.text}]}>/Users/admin/Downloads/FlowDrop/</Text>
          </DetailRow>
        </View>

        <View style={styles.actions}>
          <Pressable
            accessibilityLabel="查看文件夹"
            accessibilityRole="button"
            onPress={() => onOpenFolder?.(record)}
            style={({pressed}) => [styles.primaryButton, pressed && styles.pressed]}>
            <SymbolView name={{ios: 'folder', android: 'folder', web: 'folder'}} size={23} tintColor="#FFFFFF"/>
            <Text style={styles.primaryButtonText}>查看文件夹</Text>
          </Pressable>
          <View style={styles.secondaryActions}>
            <Pressable
              accessibilityLabel="分享文件"
              accessibilityRole="button"
              onPress={() => onShare?.(record)}
              style={({pressed}) => [styles.secondaryButton, {backgroundColor: theme.backgroundElement}, pressed && styles.pressed]}>
              <SymbolView name={{ios: 'square.and.arrow.up', android: 'share', web: 'share'}}
                          size={21}
                          tintColor={theme.text}/>
              <Text style={[styles.secondaryButtonText, {color: theme.text}]}>分享文件</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="删除记录"
              accessibilityRole="button"
              onPress={() => onDelete?.(record)}
              style={({pressed}) => [styles.secondaryButton, {backgroundColor: theme.backgroundElement}, pressed && styles.pressed]}>
              <SymbolView name={{ios: 'trash', android: 'delete', web: 'delete'}} size={21} tintColor="#F04449"/>
              <Text style={[styles.secondaryButtonText, {color: '#F04449'}]}>删除记录</Text>
            </Pressable>
          </View>
        </View>
      </BottomSheet.ScrollView>
    </BottomSheet>
  )
})

export default TransmissionRecordDetailBottomSheet

function Participant({
  icon,
  label,
  name,
  textColor
}: {
  icon: SymbolViewProps['name']
  label: string
  name: string
  textColor: string
}) {
  return (
    <View style={styles.participant}>
      <View style={styles.participantIcon}>
        <SymbolView name={icon} size={27} tintColor="#0B0B0B"/>
      </View>
      <Text style={styles.participantLabel}>{label}</Text>
      <Text numberOfLines={2} style={[styles.participantName, {color: textColor}]}>{name}</Text>
    </View>
  )
}

function DetailRow({
  children,
  label,
  last = false
}: {
  children: ReactNode
  label: string
  last?: boolean
}) {
  const theme = useTheme()

  return (
    <View style={[styles.detailRow, !last && {
      borderBottomColor: theme.backgroundElement,
      borderBottomWidth: StyleSheet.hairlineWidth
    }]}>
      <Text style={[styles.detailLabel, {color: theme.textSecondary}]}>{label}</Text>
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingBottom: 34
  },
  fileSummary: {
    alignItems: 'center',
    paddingHorizontal: PAGE_HORIZONTAL_PADDING
  },
  fileIcon: {
    alignItems: 'center',
    borderRadius: 16,
    height: 120,
    justifyContent: 'center',
    width: 120
  },
  successBadge: {
    alignItems: 'center',
    backgroundColor: '#2DC866',
    borderColor: '#FFFFFF',
    borderRadius: 15,
    borderWidth: 3,
    height: 30,
    justifyContent: 'center',
    marginTop: -5,
    width: 30
  },
  fileName: {
    fontSize: 22,
    fontWeight: '700',
    marginTop: 10,
    textAlign: 'center',
    width: '100%'
  },
  fileMetaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    marginTop: 6
  },
  fileMeta: {
    fontSize: 15
  },
  metaDot: {
    marginHorizontal: 9
  },
  routeCard: {
    alignItems: 'center',
    borderRadius: 16,
    flexDirection: 'row',
    marginHorizontal: PAGE_HORIZONTAL_PADDING,
    marginTop: 28,
    minHeight: 178,
    paddingHorizontal: 20
  },
  participant: {
    alignItems: 'center',
    flex: 1,
    minWidth: 0
  },
  participantIcon: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 26,
    height: 52,
    justifyContent: 'center',
    width: 52
  },
  participantLabel: {
    color: '#60646C',
    fontSize: 13,
    marginTop: 8
  },
  participantName: {
    fontSize: 17,
    fontWeight: '700',
    marginTop: 3,
    textAlign: 'center'
  },
  routeDirection: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    width: 58
  },
  routeLine: {
    backgroundColor: '#DDE1E5',
    height: 1,
    width: 34
  },
  routeDot: {
    backgroundColor: '#57D887',
    borderRadius: 4,
    height: 8,
    marginTop: -4,
    width: 8
  },
  detailList: {
    marginHorizontal: PAGE_HORIZONTAL_PADDING,
    marginTop: 24
  },
  detailRow: {
    alignItems: 'center',
    flexDirection: 'row',
    minHeight: 70,
    paddingVertical: 12
  },
  detailLabel: {
    fontSize: 16
  },
  statusValue: {
    alignItems: 'center',
    flexDirection: 'row',
    marginLeft: 'auto'
  },
  statusDot: {
    borderRadius: 5,
    height: 10,
    marginRight: 9,
    width: 10
  },
  statusText: {
    fontSize: 18,
    fontWeight: '700'
  },
  locationText: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 14,
    lineHeight: 20,
    marginLeft: 24,
    textAlign: 'right'
  },
  actions: {
    marginHorizontal: PAGE_HORIZONTAL_PADDING,
    marginTop: 18
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: '#050505',
    borderRadius: 12,
    flexDirection: 'row',
    gap: 10,
    height: 64,
    justifyContent: 'center'
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 19,
    fontWeight: '700'
  },
  secondaryActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 12
  },
  secondaryButton: {
    alignItems: 'center',
    borderRadius: 12,
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    height: 58,
    justifyContent: 'center'
  },
  secondaryButtonText: {
    fontSize: 16,
    fontWeight: '700'
  },
  pressed: {
    opacity: 0.72
  }
})

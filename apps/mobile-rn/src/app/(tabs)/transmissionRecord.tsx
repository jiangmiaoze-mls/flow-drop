import {SymbolView, type SymbolViewProps} from 'expo-symbols'
import {useCallback, useMemo, useRef, useState} from 'react'
import {useFocusEffect} from 'expo-router'
import {
  Animated,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  RefreshControl,
  ScrollView,
  type ScrollView as ScrollViewType,
  SectionList,
  StyleSheet,
  Text,
  TextInput, TouchableOpacity,
  useWindowDimensions,
  View
} from 'react-native'

import {Header} from '@/components/Header'
import TransmissionRecordDetailBottomSheet, {
  type TransmissionRecordDetailBottomSheetRef
} from '@/components/TransmissionRecordDetailBottomSheet'
import TransmissionRecordFilterBottomSheet, {
  TRANSMISSION_RECORD_FILE_TYPE_ICONS,
  type TransmissionRecordFilterBottomSheetRef
} from '@/components/TransmissionRecordFilterBottomSheet'
import {PAGE_HORIZONTAL_PADDING} from '@/constants/layout'
import {useTheme} from '@/hooks/use-theme'
import {listAllOutgoingTransfers, type OutgoingTransferItem} from '@/storage/outgoingTransferRepository'
import {listTrustedDevices} from '@/storage/trustedDeviceRepository'
import type {
  TransferDirection,
  TransferRecord,
  TransmissionRecordDetail,
  TransmissionRecordFileType,
  TransmissionRecordFilter,
  TransmissionRecordStatus,
} from '@flowdrop/types'


type RecordStatus = TransmissionRecordStatus
type RecordFileType = TransmissionRecordFileType

type RecordSection = {
  data: TransferRecord[]
  title: string
}

const TABS = ['全部记录', '按设备分组'] as const

const TEXTS = {
  searchPlaceholder: '搜索文件或文本...',
  searchAccessibility: '搜索文件或文本',
  filterAccessibility: '筛选传输记录',
  emptyState: '暂无真实传输记录'
} as const

const ICONS: Record<string, SymbolViewProps['name']> = {
  search: {ios: 'magnifyingglass', android: 'search', web: 'search'},
  filter: {ios: 'line.3.horizontal.decrease', android: 'tune', web: 'tune'}
}

const STATUS_CONFIG: Record<RecordStatus, {
  text: string;
  textColor: string;
  dotColor: string;
  bgVariant: string | null
}> = {
  cancelled: {
    text: '已取消',
    textColor: '#68707A',
    dotColor: '#8B949E',
    bgVariant: null
  },
  completed: {
    text: '成功',
    textColor: '#27B85D',
    dotColor: '#2DC866',
    bgVariant: null
  },
  completing: {
    text: '正在完成',
    textColor: '#B96B00',
    dotColor: '#E88B00',
    bgVariant: '#FFF0D2'
  },
  draft: {
    text: '草稿',
    textColor: '#68707A',
    dotColor: '#8B949E',
    bgVariant: null
  },
  failed: {
    text: '失败',
    textColor: '#E5484D',
    dotColor: '#F04449',
    bgVariant: '#FFD8D5'
  },
  negotiating: {
    text: '正在协商',
    textColor: '#3468C0',
    dotColor: '#4C82D9',
    bgVariant: '#DCEBFF'
  },
  paused: {
    text: '已暂停',
    textColor: '#68707A',
    dotColor: '#8B949E',
    bgVariant: null
  },
  preparing: {
    text: '正在准备',
    textColor: '#3468C0',
    dotColor: '#4C82D9',
    bgVariant: '#DCEBFF'
  },
  queued: {
    text: '等待发送',
    textColor: '#B96B00',
    dotColor: '#E88B00',
    bgVariant: '#FFF0D2'
  },
  transferring: {
    text: '传输中',
    textColor: '#3468C0',
    dotColor: '#4C82D9',
    bgVariant: '#DCEBFF'
  },
  verifying: {
    text: '正在校验',
    textColor: '#3468C0',
    dotColor: '#4C82D9',
    bgVariant: '#DCEBFF'
  },
  waiting_for_peer: {
    text: '等待对端',
    textColor: '#B96B00',
    dotColor: '#E88B00',
    bgVariant: '#FFF0D2'
  }
}

const TRANSFER_DIRECTION_CONFIG: Record<TransferDirection, {
  icon: SymbolViewProps['name']
  label: string
}> = {
  send: {
    icon: {ios: 'arrow.up.right', android: 'north_east', web: 'north_east'},
    label: '发送'
  },
  receive: {
    icon: {ios: 'arrow.down.left', android: 'south_west', web: 'south_west'},
    label: '接收'
  }
}

function matchesNormalizedQuery(record: TransferRecord, normalizedQuery: string) {
  if (!normalizedQuery) return true
  return `${record.name} ${record.detail}`.toLocaleLowerCase().includes(normalizedQuery)
}

function getRecordFileType(record: TransferRecord): RecordFileType {
  if (record.fileType) {
    return record.fileType
  }

  if (record.name.startsWith('http')) {
    return 'link'
  }

  if (record.detail === '剪贴板') {
    return 'text'
  }

  if (/\.(heic|jpeg|jpg|png|webp)$/i.test(record.name)) {
    return 'image'
  }

  if (/\.(mov|mp4|mkv|webm)$/i.test(record.name)) {
    return 'video'
  }

  return 'document'
}

function getTransferDirection(record: TransferRecord): TransferDirection {
  return record.direction ?? 'send'
}

function listTransferRecords(): TransferRecord[] {
  const deviceNames = new Map(listTrustedDevices().map((device) => [device.deviceId, device.deviceName]))
  return listAllOutgoingTransfers().flatMap((task) => task.items.map((item) => ({
    detail: getItemDetail(item),
    direction: 'send' as const,
    fileType: getItemFileType(item),
    id: `${task.transferId}:${item.itemId}`,
    name: getItemName(item),
    peerDeviceName: deviceNames.get(task.peerDeviceId) ?? task.peerDeviceId,
    sourceUri: item.sourceUri,
    status: task.status,
    time: formatTime(task.updatedAt),
    timestamp: task.updatedAt
  })))
}

function buildDateSections(records: TransferRecord[]): RecordSection[] {
  const groups = new Map<string, TransferRecord[]>()
  for (const record of records) {
    const title = formatDateLabel(record.timestamp ?? 0)
    const group = groups.get(title) ?? []
    group.push(record)
    groups.set(title, group)
  }
  return [...groups].map(([title, data]) => ({data, title}))
}

function buildDeviceSections(records: TransferRecord[]): RecordSection[] {
  const groups = new Map<string, TransferRecord[]>()
  for (const record of records) {
    const title = record.peerDeviceName ?? '未知设备'
    const group = groups.get(title) ?? []
    group.push(record)
    groups.set(title, group)
  }
  return [...groups].map(([title, data]) => ({data, title}))
}

function getItemDetail(item: OutgoingTransferItem): string {
  return item.kind === 'text' ? `文字 · ${formatBytes(item.sizeBytes)}` : formatBytes(item.sizeBytes)
}

function getItemFileType(item: OutgoingTransferItem): RecordFileType {
  if (item.kind === 'text') return 'text'
  if (item.mimeType.startsWith('image/') || /\.(heic|jpeg|jpg|png|webp)$/i.test(item.name)) return 'image'
  if (item.mimeType.startsWith('video/') || /\.(mov|mp4|mkv|webm)$/i.test(item.name)) return 'video'
  return 'document'
}

function getItemName(item: OutgoingTransferItem): string {
  if (item.kind !== 'text') return item.name
  const preview = item.text?.replace(/\s+/g, ' ').trim()
  return preview ? preview.slice(0, 80) : item.name
}

function formatDateLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const yesterday = midnight - 24 * 60 * 60 * 1000
  if (timestamp >= midnight) return '今天'
  if (timestamp >= yesterday) return '昨天'
  return date.toLocaleDateString()
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

function matchesFilter(record: TransferRecord, filter: TransmissionRecordFilter) {
  const fileTypeMatches = filter.fileTypes.length === 0 || filter.fileTypes.includes(getRecordFileType(record))
  const statusMatches = filter.statuses.length === 0
    || (filter.statuses.includes('success') && record.status === 'completed')
    || (filter.statuses.includes('failed') && record.status === 'failed')

  return fileTypeMatches && statusMatches
}

function RecordRow({
  dateLabel,
  isFirst,
  isLast,
  onPress,
  record
}: {
  dateLabel: string
  isFirst: boolean
  isLast: boolean
  onPress: (record: TransferRecord, dateLabel: string) => void
  record: TransferRecord
}) {
  const theme = useTheme()
  const config = STATUS_CONFIG[record.status]
  const fileType = getRecordFileType(record)
  const direction = TRANSFER_DIRECTION_CONFIG[getTransferDirection(record)]

  return (
    <TouchableOpacity
      accessibilityLabel={`查看 ${record.name} 的传输详情`}
      accessibilityRole="button"
      activeOpacity={.75}
      onPress={() => onPress(record, dateLabel)}
      style={[
        styles.recordRow,
        {
          backgroundColor: theme.background,
          borderBottomColor: theme.backgroundElement
        },
        isFirst && styles.recordRowFirst,
        isLast && styles.recordRowLast,
        !isLast && styles.recordRowWithSeparator
      ]}>
      <View
        style={[
          styles.recordIcon,
          {backgroundColor: config.bgVariant || theme.backgroundElement}
        ]}>
        <SymbolView
          name={TRANSMISSION_RECORD_FILE_TYPE_ICONS[fileType]}
          size={21}
          tintColor={record.status === 'failed' ? config.textColor : theme.textSecondary}
        />
      </View>

      <View style={styles.recordInfo}>
        <Text numberOfLines={1} style={[styles.recordName, {color: theme.text}]}>
          {record.name}
        </Text>
        <View style={styles.recordMetaRow}>
          <Text style={[styles.recordMeta, {color: theme.textSecondary}]}>{record.detail}</Text>
          <Text style={[styles.metaDivider, {color: theme.textSecondary}]}>•</Text>
          <Text style={[styles.recordMeta, {color: theme.textSecondary}]}>{record.time}</Text>
          <View style={styles.directionIcon}>
            <SymbolView
              accessibilityLabel={direction.label}
              name={direction.icon}
              size={14}
              tintColor={theme.textSecondary}
            />
          </View>
        </View>
      </View>

      <View style={styles.statusRow}>
        <Text style={[styles.statusText, {color: config.textColor}]}>
          {config.text}
        </Text>
        <View style={[styles.statusDot, {backgroundColor: config.dotColor}]}/>
      </View>
    </TouchableOpacity>
  )
}

function EmptyState() {
  const theme = useTheme()

  return (
    <View style={styles.emptyState}>
      <Text style={[styles.emptyText, {color: theme.textSecondary}]}>{TEXTS.emptyState}</Text>
    </View>
  )
}

function FilteredRecordList({
  filter,
  normalizedQuery,
  onRecordPress,
  onRefresh,
  refreshing,
  sections
}: {
  filter: TransmissionRecordFilter
  normalizedQuery: string
  onRecordPress: (record: TransferRecord, dateLabel: string) => void
  onRefresh: () => void
  refreshing: boolean
  sections: RecordSection[]
}) {
  const theme = useTheme()
  const filteredSections = useMemo(
    () =>
      sections
        .map((section) => ({
          ...section,
          data: section.data.filter((record) => (
            matchesNormalizedQuery(record, normalizedQuery) && matchesFilter(record, filter)
          ))
        }))
        .filter((section) => section.data.length > 0),
    [filter, normalizedQuery, sections]
  )

  return (
    <SectionList
      contentContainerStyle={styles.pageContent}
      keyExtractor={(item) => item.id}
      ListEmptyComponent={EmptyState}
      refreshControl={<RefreshControl colors={[theme.text]} onRefresh={onRefresh} refreshing={refreshing} tintColor={theme.text}/>}
      renderItem={({item, index, section}) => (
        <RecordRow
          dateLabel={section.title}
          isFirst={index === 0}
          isLast={index === section.data.length - 1}
          onPress={onRecordPress}
          record={item}
        />
      )}
      renderSectionFooter={() => <View style={styles.sectionSpacer}/>}
      renderSectionHeader={({section}) => (
        <View style={[styles.sectionHeader, {backgroundColor: theme.backgroundElement}]}>
          <Text style={[styles.sectionTitle, {color: theme.textSecondary}]}>{section.title}</Text>
        </View>
      )}
      sections={filteredSections}
      showsVerticalScrollIndicator={false}
      stickySectionHeadersEnabled
      style={styles.pageScroll}
    />
  )
}

export default function TransmissionRecord() {
  const theme = useTheme()
  const {width} = useWindowDimensions()
  const detailSheetRef = useRef<TransmissionRecordDetailBottomSheetRef>(null)
  const filterSheetRef = useRef<TransmissionRecordFilterBottomSheetRef>(null)
  const pagerRef = useRef<ScrollViewType>(null)
  const scrollX = useRef(new Animated.Value(0)).current
  const [activeTab, setActiveTab] = useState(0)
  const [filter, setFilter] = useState<TransmissionRecordFilter>({fileTypes: [], statuses: []})
  const [query, setQuery] = useState('')
  const [records, setRecords] = useState<TransferRecord[]>([])
  const [isRefreshing, setIsRefreshing] = useState(false)
  const hasActiveFilter = filter.fileTypes.length > 0 || filter.statuses.length > 0

  const normalizedQuery = useMemo(() => query.trim().toLocaleLowerCase(), [query])
  const refreshRecords = useCallback(() => {
    setRecords(listTransferRecords())
  }, [])

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      refreshRecords()
    } finally {
      setIsRefreshing(false)
    }
  }, [refreshRecords])

  useFocusEffect(useCallback(() => {
    refreshRecords()
  }, [refreshRecords]))

  const allRecordSections = useMemo(() => buildDateSections(records), [records])

  const deviceSections: RecordSection[] = useMemo(
    () => buildDeviceSections(records),
    [records]
  )

  const segmentWidth = (width - PAGE_HORIZONTAL_PADDING * 2 - 8) / TABS.length
  const indicatorTranslateX = scrollX.interpolate({
    inputRange: [0, width],
    outputRange: [0, segmentWidth],
    extrapolate: 'clamp'
  })

  const selectTab = useCallback((index: number) => {
    setActiveTab(index)
    pagerRef.current?.scrollTo({animated: true, x: width * index})
  }, [width])

  const handlePagerScrollEnd = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const nextIndex = Math.round(event.nativeEvent.contentOffset.x / Math.max(width, 1))
    setActiveTab(Math.max(0, Math.min(TABS.length - 1, nextIndex)))
  }, [width])

  const handlePagerScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollX.setValue(event.nativeEvent.contentOffset.x)
  }, [scrollX])

  const handleOpenFilter = useCallback(() => {
    filterSheetRef.current?.present()
  }, [])

  const handleOpenRecordDetail = useCallback((record: TransferRecord, dateLabel: string) => {
    const detail: TransmissionRecordDetail = {
      ...record,
      dateLabel,
      direction: getTransferDirection(record),
      fileType: getRecordFileType(record)
    }
    detailSheetRef.current?.present(detail)
  }, [])

  return (
    <View style={[styles.screen, {backgroundColor: theme.backgroundElement}]}>
      <Header style={styles.header}>
        <Header.Center>
          <Text style={[styles.headerTitle, {color: theme.text}]}>FlowDrop</Text>
        </Header.Center>
      </Header>
      <View style={styles.toolbar}>
        <View style={[styles.searchField, {backgroundColor: theme.background}]}>
          <SymbolView
            name={ICONS.search}
            size={23}
            tintColor={theme.textSecondary}
          />
          <TextInput
            accessibilityLabel={TEXTS.searchAccessibility}
            onChangeText={setQuery}
            placeholder={TEXTS.searchPlaceholder}
            placeholderTextColor={theme.textSecondary}
            style={[styles.searchInput, {color: theme.text}]}
            value={query}
          />
        </View>

        <Pressable
          accessibilityLabel={TEXTS.filterAccessibility}
          accessibilityRole="button"
          accessibilityState={{selected: hasActiveFilter}}
          onPress={handleOpenFilter}
          style={({pressed}) => [
            styles.filterButton,
            {backgroundColor: hasActiveFilter ? '#050505' : theme.background},
            pressed && styles.pressed
          ]}>
          <SymbolView
            name={ICONS.filter}
            size={22}
            tintColor={hasActiveFilter ? '#FFFFFF' : theme.textSecondary}
          />
        </Pressable>
      </View>

      <View style={[styles.tabBar, {backgroundColor: theme.backgroundSelected}]}>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.tabIndicator,
            {
              backgroundColor: theme.background,
              transform: [{translateX: indicatorTranslateX}],
              width: segmentWidth
            }
          ]}
        />
        {TABS.map((tab, index) => (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{selected: activeTab === index}}
            key={tab}
            onPress={() => selectTab(index)}
            style={({pressed}) => [
              styles.tab,
              pressed && styles.pressed
            ]}>
            <Text style={[styles.tabText, {color: activeTab === index ? theme.text : theme.textSecondary}]}>
              {tab}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView
        bounces={false}
        contentContainerStyle={styles.pagerContent}
        horizontal
        onScroll={handlePagerScroll}
        onMomentumScrollEnd={handlePagerScrollEnd}
        pagingEnabled
        ref={pagerRef}
        scrollEventThrottle={16}
        showsHorizontalScrollIndicator={false}>

        <View style={[styles.page, {width}]}> 
          <FilteredRecordList
            filter={filter}
            normalizedQuery={normalizedQuery}
            onRecordPress={handleOpenRecordDetail}
            onRefresh={() => void handleRefresh()}
            refreshing={isRefreshing}
            sections={allRecordSections}
          />
        </View>

        <View style={[styles.page, {width}]}> 
          <FilteredRecordList
            filter={filter}
            normalizedQuery={normalizedQuery}
            onRecordPress={handleOpenRecordDetail}
            onRefresh={() => void handleRefresh()}
            refreshing={isRefreshing}
            sections={deviceSections}
          />
        </View>
      </ScrollView>

      <TransmissionRecordFilterBottomSheet
        ref={filterSheetRef}
        onApply={setFilter}
        value={filter}
      />
      <TransmissionRecordDetailBottomSheet ref={detailSheetRef}/>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: {flex: 1},
  header: {backgroundColor: '#FFFFFF'},
  headerTitle: {fontSize: 23, fontWeight: '700'},
  toolbar: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: PAGE_HORIZONTAL_PADDING,
    paddingTop: 8,
    height: 50
  },
  searchField: {
    alignItems: 'center',
    borderRadius: 8,
    flex: 1,
    flexDirection: 'row',
    paddingHorizontal: 14,
    height: '100%'
  },
  searchInput: {flex: 1, fontSize: 16, marginLeft: 13, paddingVertical: 0},
  filterButton: {alignItems: 'center', borderRadius: 8, height: '100%', justifyContent: 'center', width: 48},
  tabBar: {
    borderRadius: 8,
    flexDirection: 'row',
    height: 44,
    marginHorizontal: PAGE_HORIZONTAL_PADDING,
    marginTop: 16,
    padding: 4
  },
  tab: {alignItems: 'center', borderRadius: 6, flex: 1, justifyContent: 'center'},
  tabIndicator: {borderRadius: 6, bottom: 4, left: 4, position: 'absolute', top: 4},
  tabText: {fontSize: 16, fontWeight: '600'},
  pagerContent: {flexGrow: 1},
  page: {flex: 1},
  pageContent: {paddingBottom: 28, paddingHorizontal: PAGE_HORIZONTAL_PADDING, paddingTop: 20},
  pageScroll: {flex: 1},
  sectionHeader: {paddingBottom: 10, paddingHorizontal: 8},
  sectionTitle: {fontSize: 18, fontWeight: '600'},
  sectionSpacer: {height: 20},
  recordRow: {alignItems: 'center', flexDirection: 'row', minHeight: 78, paddingHorizontal: 20},
  recordRowFirst: {borderTopLeftRadius: 11, borderTopRightRadius: 11},
  recordRowLast: {borderBottomLeftRadius: 11, borderBottomRightRadius: 11},
  recordRowWithSeparator: {borderBottomWidth: StyleSheet.hairlineWidth},
  recordIcon: {alignItems: 'center', borderRadius: 8, height: 43, justifyContent: 'center', width: 43},
  recordInfo: {flex: 1, marginLeft: 16, minWidth: 0},
  recordName: {fontSize: 16, fontWeight: '500'},
  recordMetaRow: {alignItems: 'center', flexDirection: 'row', marginTop: 2},
  recordMeta: {fontFamily: 'monospace', fontSize: 13},
  metaDivider: {fontSize: 12, marginHorizontal: 5},
  directionIcon: {marginLeft: 5},
  statusRow: {alignItems: 'center', flexDirection: 'row', marginLeft: 8},
  statusText: {fontSize: 14, fontWeight: '500'},
  statusDot: {borderRadius: 4, height: 8, marginLeft: 8, width: 8},
  emptyState: {alignItems: 'center', paddingTop: 70},
  emptyText: {fontSize: 15},
  pressed: {opacity: 0.65}
})

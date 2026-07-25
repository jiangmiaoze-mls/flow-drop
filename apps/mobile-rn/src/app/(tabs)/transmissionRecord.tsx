import {SymbolView, type SymbolViewProps} from 'expo-symbols'
import {useCallback, useMemo, useRef, useState} from 'react'
import {
  Animated,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  type ScrollView as ScrollViewType,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View
} from 'react-native'

import {Header} from '@/components/Header'
import TransmissionRecordFilterBottomSheet, {
  TRANSMISSION_RECORD_FILE_TYPE_ICONS,
  type TransmissionRecordFilter,
  type TransmissionRecordFileType,
  type TransmissionRecordFilterBottomSheetRef
} from '@/components/TransmissionRecordFilterBottomSheet'
import {PAGE_HORIZONTAL_PADDING} from '@/constants/layout'
import {useTheme} from '@/hooks/use-theme'


type RecordStatus = 'success' | 'interrupted'
type RecordFileType = TransmissionRecordFileType

type TransferRecord = {
  detail: string
  fileType?: RecordFileType
  id: string
  name: string
  status: RecordStatus
  time: string
}

type RecordSection = {
  data: TransferRecord[]
  title: string
}

type DeviceGroup = {
  deviceName: string
  records: TransferRecord[]
}

const TABS = ['全部记录', '按设备分组'] as const

const TEXTS = {
  searchPlaceholder: '搜索文件或文本...',
  searchAccessibility: '搜索文件或文本',
  filterAccessibility: '筛选传输记录',
  emptyState: '暂无匹配记录'
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
  success: {
    text: '成功',
    textColor: '#27B85D',
    dotColor: '#2DC866',
    bgVariant: null
  },
  interrupted: {
    text: '中断',
    textColor: '#E5484D',
    dotColor: '#F04449',
    bgVariant: '#FFD8D5'
  }
}

const ALL_RECORD_SECTIONS: RecordSection[] = [
  {
    title: '今天',
    data: [
      {detail: '14.2 MB', fileType: 'document', id: 'q3-report', name: 'Q3_Financial_Report.pdf', status: 'success', time: '10:42'},
      {detail: '剪贴板', fileType: 'text', id: 'release-note', name: '今晚 20:00 发布新版客户端', status: 'success', time: '09:36'},
      {
        detail: '剪贴板',
        fileType: 'link',
        id: 'design-system-link',
        name: 'https://designsystem.flo...',
        status: 'success',
        time: '09:15'
      },
      {detail: '4.1 MB', fileType: 'image', id: 'img-8921', name: 'IMG_8921.HEIC', status: 'interrupted', time: '08:30'},
      {detail: '86.4 MB', fileType: 'video', id: 'product-demo', name: 'Product_Demo.mp4', status: 'success', time: '08:12'}
    ]
  },
  {
    title: '昨天',
    data: [
      {detail: '1.2 GB', fileType: 'document', id: 'assets-zip', name: 'Assets_V2_Final.zip', status: 'success', time: '16:45'},
      {detail: '剪贴板', fileType: 'text', id: 'handoff-note', name: '交接说明已同步到对方设备', status: 'interrupted', time: '14:28'},
      {detail: '41.7 MB', fileType: 'video', id: 'launch-video', name: 'Launch_Recap.mov', status: 'success', time: '10:06'}
    ]
  }
]

const DEVICE_GROUPS: DeviceGroup[] = [
  {
    deviceName: 'WIN-OFFICE-X1',
    records: [
      {detail: '14.2 MB', id: 'device-q3-report', name: 'Q3_Financial_Report.pdf', status: 'success', time: '10:42'},
      {detail: '14.2 MB', id: 'device-1-report', name: 'Q3_Financial_Report.pdf', status: 'success', time: '10:42'},
      {detail: '14.2 MB', id: 'device-2-report', name: 'Q3_Financial_Report.pdf', status: 'success', time: '10:42'},
      {detail: '14.2 MB', id: 'device-3-report', name: 'Q3_Financial_Report.pdf', status: 'success', time: '10:42'},
      {detail: '14.2 MB', id: 'device-4-report', name: 'Q3_Financial_Report.pdf', status: 'success', time: '10:42'},
      {detail: '14.2 MB', id: 'device-q3-rep11ort', name: 'Q3_Financial_Report.pdf', status: 'success', time: '10:42'},
      {detail: '14.2 MB', id: 'device-q3-r11eport', name: 'Q3_Financial_Report.pdf', status: 'success', time: '10:42'},
      {detail: '14.2 MB', id: 'devic11e-q3-report', name: 'Q3_Financial_Report.pdf', status: 'success', time: '10:42'},
      {detail: '86.4 MB', fileType: 'video', id: 'device-product-demo', name: 'Product_Demo.mp4', status: 'success', time: '09:47'},
      {detail: '剪贴板', fileType: 'text', id: 'device-handoff-note', name: '请在下午三点前确认素材', status: 'interrupted', time: '09:32'},
      {detail: '6.8 MB', fileType: 'image', id: 'device-cover-image', name: 'Cover_Artwork.png', status: 'success', time: '09:21'},
      {
        detail: '剪贴板',
        fileType: 'link',
        id: 'device-design-system-link',
        name: 'https://designsystem.flo...',
        status: 'success',
        time: '09:15'
      }
    ]
  },
  {
    deviceName: 'MAC-STUDIO-DESIGN',
    records: [
      {detail: '4.1 MB', fileType: 'image', id: 'device-img-8921', name: 'IMG_8921.HEIC', status: 'interrupted', time: '08:30'},
      {detail: '1.2 GB', fileType: 'document', id: 'device-assets-zip', name: 'Assets_V2_Final.zip', status: 'success', time: '16:45'},
      {detail: '剪贴板', fileType: 'link', id: 'device-brief-link', name: 'https://flowdrop.design/brief', status: 'success', time: '15:18'},
      {detail: '剪贴板', fileType: 'text', id: 'device-copy-note', name: '品牌图形已按深色模式调整', status: 'success', time: '12:06'},
      {detail: '41.7 MB', fileType: 'video', id: 'device-launch-video', name: 'Launch_Recap.mov', status: 'interrupted', time: '11:20'}
    ]
  }
]

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

function matchesFilter(record: TransferRecord, filter: TransmissionRecordFilter) {
  const fileTypeMatches = filter.fileTypes.length === 0 || filter.fileTypes.includes(getRecordFileType(record))
  const statusMatches = filter.statuses.length === 0
    || (filter.statuses.includes('success') && record.status === 'success')
    || (filter.statuses.includes('failed') && record.status === 'interrupted')

  return fileTypeMatches && statusMatches
}

function RecordRow({
  isFirst,
  isLast,
  record
}: {
  isFirst: boolean
  isLast: boolean
  record: TransferRecord
}) {
  const theme = useTheme()
  const config = STATUS_CONFIG[record.status]
  const fileType = getRecordFileType(record)

  return (
    <View
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
          tintColor={record.status === 'interrupted' ? config.textColor : theme.textSecondary}
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
        </View>
      </View>

      <View style={styles.statusRow}>
        <Text style={[styles.statusText, {color: config.textColor}]}>
          {config.text}
        </Text>
        <View style={[styles.statusDot, {backgroundColor: config.dotColor}]}/>
      </View>
    </View>
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
  sections
}: {
  filter: TransmissionRecordFilter
  normalizedQuery: string
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
      renderItem={({item, index, section}) => (
        <RecordRow
          isFirst={index === 0}
          isLast={index === section.data.length - 1}
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
  const filterSheetRef = useRef<TransmissionRecordFilterBottomSheetRef>(null)
  const pagerRef = useRef<ScrollViewType>(null)
  const scrollX = useRef(new Animated.Value(0)).current
  const [activeTab, setActiveTab] = useState(0)
  const [filter, setFilter] = useState<TransmissionRecordFilter>({fileTypes: [], statuses: []})
  const [query, setQuery] = useState('')

  // 优化：统一在顶层处理字符串格式化
  const normalizedQuery = useMemo(() => query.trim().toLocaleLowerCase(), [query])

  const deviceSections: RecordSection[] = useMemo(
    () => DEVICE_GROUPS.map((group) => ({data: group.records, title: group.deviceName})),
    []
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
          onPress={handleOpenFilter}
          style={({pressed}) => [
            styles.filterButton,
            {backgroundColor: theme.background},
            pressed && styles.pressed
          ]}>
          <SymbolView
            name={ICONS.filter}
            size={22}
            tintColor={theme.textSecondary}
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
          <FilteredRecordList filter={filter} sections={ALL_RECORD_SECTIONS} normalizedQuery={normalizedQuery}/>
        </View>

        <View style={[styles.page, {width}]}> 
          <FilteredRecordList filter={filter} sections={deviceSections} normalizedQuery={normalizedQuery}/>
        </View>
      </ScrollView>

      <TransmissionRecordFilterBottomSheet
        ref={filterSheetRef}
        onApply={setFilter}
        value={filter}
      />
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
  recordMetaRow: {alignItems: 'center', flexDirection: 'row', marginTop: 3},
  recordMeta: {fontFamily: 'monospace', fontSize: 14},
  metaDivider: {fontSize: 13, marginHorizontal: 7},
  statusRow: {alignItems: 'center', flexDirection: 'row', marginLeft: 8},
  statusText: {fontSize: 14, fontWeight: '500'},
  statusDot: {borderRadius: 4, height: 8, marginLeft: 8, width: 8},
  emptyState: {alignItems: 'center', paddingTop: 70},
  emptyText: {fontSize: 15},
  pressed: {opacity: 0.65}
})

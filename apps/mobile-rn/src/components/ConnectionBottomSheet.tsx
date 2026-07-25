import {
  BottomSheetBackdrop,
  type BottomSheetBackdropProps,
  BottomSheetModal,
  BottomSheetView
} from '@gorhom/bottom-sheet'
import {type BarcodeScanningResult, CameraView} from 'expo-camera'
import {PermissionStatus} from 'expo-location'
import {SymbolView} from 'expo-symbols'
import {forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState} from 'react'
import type {NativeScrollEvent, NativeSyntheticEvent, ScrollView as ScrollViewType} from 'react-native'
import {
  Animated,
  ActivityIndicator,
  AppState,
  BackHandler,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View
} from 'react-native'

import {PAGE_HORIZONTAL_PADDING} from '@/constants/layout'
import {useCameraPermission} from '@/hooks/usePermissions'
import {useStableBottomSheetGesture} from '@/hooks/use-stable-bottom-sheet-gesture'
import {useTheme} from '@/hooks/use-theme'


const CODE_LENGTH = 6
const SEGMENT_PADDING = 4
const SCAN_FRAME_INSET = 10
const KEYPAD_ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9']
] as const

type PageIndex = 0 | 1

export type ConnectionBottomSheetRef = {
  dismiss: () => void
  present: () => void
}

type ConnectionBottomSheetProps = {
  initialCode?: string
  onConfirm?: (code: string) => void
}

const ConnectionBottomSheet = forwardRef<ConnectionBottomSheetRef, ConnectionBottomSheetProps>(
  function ConnectionBottomSheet({initialCode = '', onConfirm}, ref) {
    const theme = useTheme()
    const {width: windowWidth, height: windowHeight} = useWindowDimensions()
    const bottomSheetRef = useRef<BottomSheetModal>(null)
    const pagerRef = useRef<ScrollViewType>(null)
    const scrollX = useRef(new Animated.Value(0)).current
    const scanLineY = useRef(new Animated.Value(0)).current
    const hasConfirmedScan = useRef(false)
    const hasRequestedCameraForScannerEntry = useRef(false)
    const targetPage = useRef<PageIndex>(0)
    const pendingCameraPermissionFlow = useRef<'request' | 'settings' | null>(null)
    const shouldReopenScannerAfterSettings = useRef(false)
    const {
      authorizeCameraPermission,
      cameraPermission,
      checkCameraPermission,
      requestCameraPermission,
    } = useCameraPermission()
    const [activePage, setActivePage] = useState<PageIndex>(0)
    const [isPagerTransitioning, setIsPagerTransitioning] = useState(false)
    const [isScannerPageVisible, setIsScannerPageVisible] = useState(false)
    const [isPresented, setIsPresented] = useState(false)

    const [digits, setDigits] = useState(() => {
      const initialDigits = initialCode.replace(/\D/g, '').slice(0, CODE_LENGTH)
      return Array.from({length: CODE_LENGTH}, (_, index) => initialDigits[index] ?? '')
    })
    const [selectedIndex, setSelectedIndex] = useState(() => (
      Math.min(initialCode.replace(/\D/g, '').length, CODE_LENGTH - 1)
    ))

    // ---------------- 动态参数计算 ----------------
    const pageWidth = windowWidth
    const segmentWidth = pageWidth - PAGE_HORIZONTAL_PADDING * 2
    const pagerHeight = Math.max(350, Math.min(390, windowHeight * 0.45))
    const contentHeight = pagerHeight + 72
    const sheetSnapPoints = useMemo(() => [contentHeight + 20], [contentHeight])
    const scanFrameSize = Math.min(224, segmentWidth * 0.7)
    const scanLineTravel = scanFrameSize - SCAN_FRAME_INSET * 2 - 2
    // --------------------------------------------

    const isCodeComplete = digits.every(Boolean)
    const hasCameraPermission = cameraPermission.status === PermissionStatus.GRANTED
    const shouldRenderCameraPlaceholder = isScannerPageVisible && hasCameraPermission
    const isCameraActive = activePage === 1 && !isPagerTransitioning && shouldRenderCameraPlaceholder
    const shouldShowCameraPermissionGuide = cameraPermission.resolved && !hasCameraPermission

    const indicatorWidth = (segmentWidth - SEGMENT_PADDING * 2) / 2
    const indicatorTranslateX = scrollX.interpolate({
      inputRange: [0, pageWidth],
      outputRange: [0, indicatorWidth],
      extrapolate: 'clamp'
    })

    const resetPager = useCallback(() => {
      hasConfirmedScan.current = false
      hasRequestedCameraForScannerEntry.current = false
      targetPage.current = 0
      scrollX.setValue(0)
      setActivePage(0)
      setIsPagerTransitioning(false)
      setIsScannerPageVisible(false)
      pagerRef.current?.scrollTo({animated: false, x: 0})
    }, [scrollX])

    const presentScannerPage = useCallback(() => {
      hasConfirmedScan.current = false
      // 授权弹窗结束后不再自动二次请求；未授权时直接显示授权引导。
      hasRequestedCameraForScannerEntry.current = true
      targetPage.current = 1
      scrollX.setValue(pageWidth)
      setActivePage(1)
      setIsPagerTransitioning(false)
      setIsScannerPageVisible(true)
      setIsPresented(true)
      bottomSheetRef.current?.present()

      requestAnimationFrame(() => {
        scrollX.setValue(pageWidth)
        setActivePage(1)
        setIsPagerTransitioning(false)
        setIsScannerPageVisible(true)
        pagerRef.current?.scrollTo({animated: false, x: pageWidth})
      })
    }, [pageWidth, scrollX])

    const startCameraPermissionRequest = useCallback(async () => {
      const permission = await checkCameraPermission()

      if (permission.status !== PermissionStatus.UNDETERMINED) return

      pendingCameraPermissionFlow.current = 'request'
      bottomSheetRef.current?.dismiss()
    }, [checkCameraPermission])

    const handleAuthorizeCamera = useCallback(async () => {
      const permission = await checkCameraPermission()

      pendingCameraPermissionFlow.current = permission.status === PermissionStatus.UNDETERMINED
        ? 'request'
        : 'settings'
      bottomSheetRef.current?.dismiss()
    }, [checkCameraPermission])

    // 暴露 ref 方法
    const present = useCallback(() => {
      resetPager()
      setIsPresented(true)
      bottomSheetRef.current?.present()
    }, [resetPager])

    const dismiss = useCallback(() => {
      bottomSheetRef.current?.dismiss()
    }, [])

    useImperativeHandle(ref, () => ({dismiss, present}), [dismiss, present])

    // 安卓物理返回键监听
    useEffect(() => {
      if (!isPresented) return

      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        dismiss()
        return true
      })
      return () => subscription.remove()
    }, [dismiss, isPresented])

    const handleDismiss = useCallback(() => {
      setIsPresented(false)
      resetPager()

      const pendingFlow = pendingCameraPermissionFlow.current
      pendingCameraPermissionFlow.current = null

      if (pendingFlow === 'request') {
        void (async () => {
          try {
            await requestCameraPermission()
          } finally {
            presentScannerPage()
          }
        })()
        return
      }

      if (pendingFlow === 'settings') {
        shouldReopenScannerAfterSettings.current = true
        void authorizeCameraPermission()
      }
    }, [authorizeCameraPermission, presentScannerPage, requestCameraPermission, resetPager])

    const handleSheetChange = useCallback((index: number) => {
      if (index < 0 || targetPage.current !== 1) return

      requestAnimationFrame(() => {
        pagerRef.current?.scrollTo({animated: false, x: pageWidth})
      })
    }, [pageWidth])

    useEffect(() => {
      const subscription = AppState.addEventListener('change', (nextState) => {
        if (nextState !== 'active' || !shouldReopenScannerAfterSettings.current) return

        shouldReopenScannerAfterSettings.current = false
        void checkCameraPermission().finally(presentScannerPage)
      })

      return () => subscription.remove()
    }, [checkCameraPermission, presentScannerPage])

    const renderBackdrop = useCallback((props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={0.38}
        pressBehavior="close"
      />
    ), [])

    useEffect(() => {
      const hasSettledOnScannerPage = activePage === 1 && !isPagerTransitioning

      if (!hasSettledOnScannerPage) {
        if (activePage === 0) {
          hasRequestedCameraForScannerEntry.current = false
        }
        return
      }

      if (hasRequestedCameraForScannerEntry.current) return

      hasRequestedCameraForScannerEntry.current = true
      void startCameraPermissionRequest()
    }, [activePage, isPagerTransitioning, startCameraPermissionRequest])

    useEffect(() => {
      if (activePage === 1) {
        hasConfirmedScan.current = false
      }
    }, [activePage])

    useEffect(() => {
      if (!isCameraActive) {
        scanLineY.stopAnimation()
        scanLineY.setValue(0)
        return
      }

      const scanAnimation = Animated.loop(
        Animated.sequence([
          Animated.timing(scanLineY, {
            duration: 1700,
            easing: Easing.inOut(Easing.ease),
            toValue: scanLineTravel,
            useNativeDriver: true
          }),
          Animated.timing(scanLineY, {
            duration: 1700,
            easing: Easing.inOut(Easing.ease),
            toValue: 0,
            useNativeDriver: true
          })
        ])
      )

      scanAnimation.start()
      return () => {
        scanAnimation.stop()
        scanLineY.setValue(0)
      }
    }, [isCameraActive, scanLineY, scanLineTravel])

    // 交互逻辑
    const selectPage = useCallback((page: PageIndex) => {
      if (page === activePage) return

      setIsPagerTransitioning(true)
      setIsScannerPageVisible(page === 1)
      pagerRef.current?.scrollTo({animated: true, x: page * pageWidth})
    }, [activePage, pageWidth])

    const handleScrollBeginDrag = useCallback(() => {
      setIsPagerTransitioning(true)
    }, [])

    const handleMomentumScrollEnd = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const nextPage = Math.round(event.nativeEvent.contentOffset.x / pageWidth) === 0 ? 0 : 1
      setActivePage(nextPage)
      setIsPagerTransitioning(false)
      setIsScannerPageVisible(nextPage === 1)
    }, [pageWidth])

    const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offsetX = event.nativeEvent.contentOffset.x
      scrollX.setValue(offsetX)
      setIsScannerPageVisible((current) => {
        const next = offsetX > 0
        return current === next ? current : next
      })
    }, [scrollX])

    const inputDigit = useCallback((digit: string) => {
      setDigits((current) => {
        const next = [...current]
        next[selectedIndex] = digit
        return next
      })
      setSelectedIndex((current) => Math.min(current + 1, CODE_LENGTH - 1))
    }, [selectedIndex])

    const removeDigit = useCallback(() => {
      const deleteIndex = digits[selectedIndex] ? selectedIndex : Math.max(0, selectedIndex - 1)
      setDigits((current) => {
        const next = [...current]
        next[deleteIndex] = ''
        return next
      })
      setSelectedIndex(deleteIndex)
    }, [digits, selectedIndex])

    const handleBarcodeScanned = useCallback(({data}: BarcodeScanningResult) => {
      if (!data || !onConfirm || hasConfirmedScan.current) return
      hasConfirmedScan.current = true
      onConfirm(data)
    }, [onConfirm])

    return (
      <BottomSheetModal
        backdropComponent={renderBackdrop}
        backgroundStyle={{backgroundColor: theme.background}}
        enableContentPanningGesture={false}
        enableDismissOnClose
        enableDynamicSizing={false}
        handleComponent={() => null}
        enableHandlePanningGesture={false}
        enablePanDownToClose={false}
        enableOverDrag={false}
        gestureEventsHandlersHook={useStableBottomSheetGesture}
        onChange={handleSheetChange}
        onDismiss={handleDismiss}
        ref={bottomSheetRef}
        snapPoints={sheetSnapPoints}>
        <BottomSheetView style={styles.bottomSheetContent}>
          <View style={[styles.root, {backgroundColor: theme.background, height: contentHeight}]}>
            <View style={styles.segmentContent}>
              <View style={[styles.segmentTrack, {backgroundColor: theme.backgroundElement}]}>
                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.segmentIndicator,
                    {
                      backgroundColor: theme.background,
                      transform: [{translateX: indicatorTranslateX}],
                      width: indicatorWidth
                    }
                  ]}
                />

                <SegmentButton active={activePage === 0} label="输入配提示" onPress={() => selectPage(0)}/>
                <SegmentButton active={activePage === 1} label="扫码连接" onPress={() => selectPage(1)}/>
              </View>
            </View>

            <View style={[styles.pagerViewport, {width: pageWidth, height: pagerHeight}]}>
              <ScrollView
                bounces={false}
                contentOffset={{x: activePage * pageWidth, y: 0}}
                horizontal
                onScrollBeginDrag={handleScrollBeginDrag}
                onMomentumScrollEnd={handleMomentumScrollEnd}
                onScroll={handleScroll}
                contentContainerStyle={[styles.pagerContent, {height: pagerHeight}]}
                decelerationRate="fast"
                directionalLockEnabled
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled
                pagingEnabled
                ref={pagerRef}
                scrollEventThrottle={16}
                showsHorizontalScrollIndicator={false}
                style={[styles.pager, {width: pageWidth, height: pagerHeight}]}>
                <View style={[styles.page, {width: pageWidth, height: pagerHeight}]}>
                  <View style={styles.codeRow}>
                    {Array.from({length: CODE_LENGTH}, (_, index) => {
                      const isActive = index === selectedIndex

                      return (
                        <Pressable
                          accessibilityLabel={`配对码第 ${index + 1} 位${digits[index] ? `，当前为 ${digits[index]}` : ''}`}
                          accessibilityRole="button"
                          key={index}
                          onPress={() => setSelectedIndex(index)}
                          style={[
                            styles.codeCell,
                            {borderColor: isActive ? theme.text : theme.textSecondary}
                          ]}>
                          <Text style={[styles.codeDigit, {color: theme.text}]}>{digits[index]}</Text>
                        </Pressable>
                      )
                    })}
                  </View>

                  <View style={styles.keypad}>
                    {KEYPAD_ROWS.map((row) => (
                      <View key={row[0]} style={styles.keypadRow}>
                        {row.map((digit) => (
                          <KeypadButton key={digit} label={digit} onPress={() => inputDigit(digit)}/>
                        ))}
                      </View>
                    ))}

                    <View style={styles.keypadRow}>
                      <View style={styles.keypadCell}/>
                      <KeypadButton label="0" onPress={() => inputDigit('0')}/>
                      <View style={styles.keypadCell}>
                        <Pressable
                          accessibilityLabel="删除一位配对码"
                          accessibilityRole="button"
                          hitSlop={10}
                          onPress={removeDigit}
                          style={({pressed}) => [styles.deleteButton, pressed && styles.pressed]}>
                          <SymbolView
                            name={{ios: 'delete.left', android: 'backspace', web: 'backspace'}}
                            size={25}
                            tintColor={theme.textSecondary}
                          />
                        </Pressable>
                      </View>
                    </View>
                  </View>

                  <Pressable
                    accessibilityState={{disabled: !isCodeComplete}}
                    accessibilityRole="button"
                    disabled={!isCodeComplete}
                    onPress={() => onConfirm?.(digits.join(''))}
                    style={({pressed}) => [
                      styles.confirmButton,
                      !isCodeComplete && {
                        backgroundColor: theme.backgroundSelected
                      },
                      pressed && styles.confirmButtonPressed
                    ]}>
                    <Text
                      style={[
                        styles.confirmText,
                        !isCodeComplete && {color: theme.textSecondary}
                      ]}>
                      确定
                    </Text>
                  </Pressable>
                </View>

                <View style={[styles.page, {width: pageWidth, height: pagerHeight}]}>
                  {isCameraActive ? (
                    <View style={styles.cameraViewport}>
                      <CameraView
                        barcodeScannerSettings={{barcodeTypes: ['qr']}}
                        facing="back"
                        onBarcodeScanned={handleBarcodeScanned}
                        style={StyleSheet.absoluteFill}
                      />
                      <View pointerEvents="none" style={styles.scanOverlay}>
                        <View style={[styles.scanFrame, {width: scanFrameSize, height: scanFrameSize}]}>
                          <View style={[styles.scanCorner, styles.scanCornerTopLeft]}/>
                          <View style={[styles.scanCorner, styles.scanCornerTopRight]}/>
                          <View style={[styles.scanCorner, styles.scanCornerBottomLeft]}/>
                          <View style={[styles.scanCorner, styles.scanCornerBottomRight]}/>

                          <Animated.View
                            style={[
                              styles.scanLineContainer,
                              {
                                transform: [{translateY: scanLineY}],
                                left: SCAN_FRAME_INSET,
                                right: SCAN_FRAME_INSET,
                                top: SCAN_FRAME_INSET
                              }
                            ]}>
                            <View style={styles.scanLineGlow}/>
                            <View style={styles.scanLine}/>
                          </Animated.View>
                        </View>
                      </View>
                    </View>
                  ) : shouldShowCameraPermissionGuide ? (
                    <CameraPermissionContent onAuthorize={handleAuthorizeCamera}/>
                  ) : shouldRenderCameraPlaceholder ? (
                    <View style={styles.cameraViewport}/>
                  ) : (
                    <View style={[styles.cameraViewport, styles.cameraLoading]}>
                      <ActivityIndicator color="#FFFFFF"/>
                    </View>
                  )}
                </View>
              </ScrollView>
            </View>
          </View>
        </BottomSheetView>
      </BottomSheetModal>
    )
  }
)

export default ConnectionBottomSheet

// --- 底下这部分原样保留 ---

type SegmentButtonProps = {
  active: boolean
  label: string
  onPress: () => void
}

function SegmentButton({active, label, onPress}: SegmentButtonProps) {
  const theme = useTheme()

  return (
    <Pressable accessibilityRole="tab" onPress={onPress} style={styles.segmentButton}>
      <Text
        style={[
          styles.segmentLabel,
          {color: active ? theme.text : theme.textSecondary},
          active && styles.segmentLabelActive
        ]}>
        {label}
      </Text>
    </Pressable>
  )
}

type KeypadButtonProps = {
  label: string
  onPress: () => void
}

function KeypadButton({label, onPress}: KeypadButtonProps) {
  const theme = useTheme()

  return (
    <View style={styles.keypadCell}>
      <Pressable
        accessibilityLabel={`输入数字 ${label}`}
        accessibilityRole="button"
        onPress={onPress}
        style={({pressed}) => [
          styles.keypadButton,
          {backgroundColor: theme.backgroundElement},
          pressed && styles.pressed
        ]}>
        <Text style={[styles.keypadLabel, {color: theme.text}]}>{label}</Text>
      </Pressable>
    </View>
  )
}

type CameraPermissionContentProps = {
  onAuthorize: () => void
}

function CameraPermissionContent({onAuthorize}: CameraPermissionContentProps) {
  const theme = useTheme()

  return (
    <View style={styles.permissionContent}>
      <View style={[styles.permissionIcon, {backgroundColor: theme.backgroundElement}]}>
        <SymbolView
          name={{ios: 'qrcode.viewfinder', android: 'qr_code_scanner', web: 'qr_code_scanner'}}
          size={48}
          tintColor={theme.text}
        />
      </View>

      <Text style={[styles.permissionTitle, {color: theme.text}]}>开启相机权限</Text>
      <Text style={[styles.permissionDescription, {color: theme.textSecondary}]}>
        为了扫描电脑端的配对二维码，我们需要访问您的相机。
      </Text>

      <Pressable
        accessibilityLabel="立即授权相机权限"
        accessibilityRole="button"
        onPress={onAuthorize}
        style={({pressed}) => [
          styles.permissionButton,
          pressed && styles.confirmButtonPressed
        ]}>
        <Text style={styles.permissionButtonText}>立即授权</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  bottomSheetContent: {
    paddingTop: 20,
    alignItems: 'stretch'
  },
  root: {
    paddingBottom: 12,
    width: '100%'
  },
  segmentContent: {
    paddingHorizontal: PAGE_HORIZONTAL_PADDING
  },
  segmentTrack: {
    borderRadius: 12,
    flexDirection: 'row',
    height: 42,
    padding: SEGMENT_PADDING,
    position: 'relative'
  },
  segmentIndicator: {
    borderRadius: 9,
    bottom: SEGMENT_PADDING,
    left: SEGMENT_PADDING,
    position: 'absolute',
    top: SEGMENT_PADDING
  },
  segmentButton: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    zIndex: 1
  },
  segmentLabel: {
    fontSize: 15
  },
  segmentLabelActive: {
    fontWeight: '700'
  },
  pagerViewport: {
    marginTop: 16,
    overflow: 'hidden'
  },
  pager: {},
  pagerContent: {},
  page: {
    flexShrink: 0,
    paddingBottom: 1,
    paddingHorizontal: PAGE_HORIZONTAL_PADDING
  },
  codeRow: {
    flexDirection: 'row',
    gap: 10
  },
  codeCell: {
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 2,
    flex: 1,
    height: 54,
    justifyContent: 'center',
    minWidth: 0
  },
  codeDigit: {
    fontSize: 27,
    fontWeight: '700'
  },
  keypad: {
    gap: 8,
    marginTop: 20
  },
  keypadRow: {
    flexDirection: 'row',
    gap: 10
  },
  keypadCell: {
    flex: 1,
    height: 48,
    minWidth: 0
  },
  keypadButton: {
    alignItems: 'center',
    borderRadius: 12,
    flex: 1,
    justifyContent: 'center'
  },
  keypadLabel: {
    fontSize: 17,
    fontWeight: '500'
  },
  deleteButton: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center'
  },
  pressed: {
    opacity: 0.6
  },
  confirmButton: {
    alignItems: 'center',
    backgroundColor: '#050505',
    borderRadius: 27,
    height: 54,
    justifyContent: 'center',
    marginTop: 'auto'
  },
  confirmButtonPressed: {
    opacity: 0.78
  },
  confirmText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700'
  },
  cameraViewport: {
    backgroundColor: '#111111',
    borderRadius: 16,
    flex: 1,
    overflow: 'hidden'
  },
  cameraLoading: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  scanFrame: {
    position: 'relative'
  },
  scanCorner: {
    borderColor: '#FFFFFF',
    height: 32,
    position: 'absolute',
    width: 32
  },
  scanCornerTopLeft: {
    borderLeftWidth: 3,
    borderTopWidth: 3,
    left: 0,
    top: 0
  },
  scanCornerTopRight: {
    borderRightWidth: 3,
    borderTopWidth: 3,
    right: 0,
    top: 0
  },
  scanCornerBottomLeft: {
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    bottom: 0,
    left: 0
  },
  scanCornerBottomRight: {
    borderBottomWidth: 3,
    borderRightWidth: 3,
    bottom: 0,
    right: 0
  },
  scanLineContainer: {
    alignItems: 'center',
    height: 10,
    justifyContent: 'center',
    position: 'absolute'
  },
  scanLineGlow: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(105, 240, 160, 0.2)',
    borderRadius: 5
  },
  scanLine: {
    backgroundColor: '#69F0A0',
    borderRadius: 1,
    height: 2,
    width: '100%'
  },
  permissionContent: {
    alignItems: 'center',
    flex: 1
  },
  permissionIcon: {
    alignItems: 'center',
    borderRadius: 20,
    height: 96,
    justifyContent: 'center',
    width: 96
  },
  permissionTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginTop: 20
  },
  permissionDescription: {
    fontSize: 16,
    lineHeight: 23,
    marginTop: 8,
    maxWidth: 330,
    textAlign: 'center'
  },
  permissionButton: {
    alignItems: 'center',
    alignSelf: 'stretch',
    backgroundColor: '#050505',
    borderRadius: 27,
    height: 54,
    justifyContent: 'center',
    marginTop: 'auto'
  },
  permissionButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700'
  }
})

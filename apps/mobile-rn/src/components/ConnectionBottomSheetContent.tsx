import {
  CameraView,
  PermissionStatus,
  useCameraPermissions,
  type BarcodeScanningResult,
} from 'expo-camera'
import {SymbolView} from 'expo-symbols'
import {useCallback, useEffect, useRef, useState} from 'react'
import type {
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView as ScrollViewType,
} from 'react-native'
import {
  Animated,
  AppState,
  Easing,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native'

import {PAGE_HORIZONTAL_PADDING} from '@/constants/layout'
import {useTheme} from '@/hooks/use-theme'

const CODE_LENGTH = 6
const SEGMENT_PADDING = 4
const SCAN_FRAME_INSET = 10
const KEYPAD_ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
] as const

type PageIndex = 0 | 1

type ConnectionBottomSheetContentProps = {
  initialCode?: string
  onConfirm?: (code: string) => void
}

export default function ConnectionBottomSheetContent({
  initialCode = '',
  onConfirm,
}: ConnectionBottomSheetContentProps) {
  const theme = useTheme()
  const {width: windowWidth, height: windowHeight} = useWindowDimensions()
  const pagerRef = useRef<ScrollViewType>(null)
  const scrollX = useRef(new Animated.Value(0)).current
  const scanLineY = useRef(new Animated.Value(0)).current
  const hasRequestedCameraPermission = useRef(false)
  const hasConfirmedScan = useRef(false)
  const [cameraPermission, requestCameraPermission, getCameraPermission] = useCameraPermissions()
  const [activePage, setActivePage] = useState<PageIndex>(0)
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

  // 动态计算 Pager 和整体高度，设置安全底线值以防内容溢出
  const pagerHeight = Math.max(350, Math.min(390, windowHeight * 0.45))
  const contentHeight = pagerHeight + 72 // 72px 为顶部页签和内边距所需的固定空间

  // 动态计算扫码框大小（最大224，或占据容器宽度的70%）与扫描线轨迹
  const scanFrameSize = Math.min(224, segmentWidth * 0.7)
  const scanLineTravel = scanFrameSize - SCAN_FRAME_INSET * 2 - 2
  // --------------------------------------------

  const isCodeComplete = digits.every(Boolean)
  const isCameraActive = activePage === 1 && cameraPermission?.granted === true

  const indicatorWidth = (segmentWidth - SEGMENT_PADDING * 2) / 2
  const indicatorTranslateX = scrollX.interpolate({
    inputRange: [0, pageWidth],
    outputRange: [0, indicatorWidth],
    extrapolate: 'clamp',
  })

  useEffect(() => {
    const shouldRequestPermission = activePage === 1
      && cameraPermission?.status === PermissionStatus.UNDETERMINED
      && cameraPermission.canAskAgain
      && !hasRequestedCameraPermission.current

    if (!shouldRequestPermission) {
      return
    }

    hasRequestedCameraPermission.current = true
    void requestCameraPermission()
  }, [activePage, cameraPermission, requestCameraPermission])

  useEffect(() => {
    if (
      activePage !== 1
      || cameraPermission?.granted
      || cameraPermission?.canAskAgain !== false
    ) {
      return
    }

    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void getCameraPermission()
      }
    })

    return () => subscription.remove()
  }, [activePage, cameraPermission, getCameraPermission])

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
          useNativeDriver: true,
        }),
        Animated.timing(scanLineY, {
          duration: 1700,
          easing: Easing.inOut(Easing.ease),
          toValue: 0,
          useNativeDriver: true,
        }),
      ]),
    )

    scanAnimation.start()

    return () => {
      scanAnimation.stop()
      scanLineY.setValue(0)
    }
  }, [isCameraActive, scanLineY, scanLineTravel])

  const selectPage = useCallback((page: PageIndex) => {
    setActivePage(page)
    pagerRef.current?.scrollTo({animated: true, x: page * pageWidth})
  }, [pageWidth])

  const handleMomentumScrollEnd = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const nextPage = Math.round(event.nativeEvent.contentOffset.x / pageWidth) === 0 ? 0 : 1
    setActivePage(nextPage)
  }, [pageWidth])

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollX.setValue(event.nativeEvent.contentOffset.x)
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

  const handleAuthorizeCamera = useCallback(async () => {
    if (!cameraPermission || cameraPermission.canAskAgain) {
      await requestCameraPermission()
      return
    }

    await Linking.openSettings()
  }, [cameraPermission, requestCameraPermission])

  const handleBarcodeScanned = useCallback(({data}: BarcodeScanningResult) => {
    if (!data || !onConfirm || hasConfirmedScan.current) {
      return
    }

    hasConfirmedScan.current = true
    onConfirm(data)
  }, [onConfirm])

  return (
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
                width: indicatorWidth,
              },
            ]}
          />

          <SegmentButton active={activePage === 0} label="输入配对码" onPress={() => selectPage(0)}/>
          <SegmentButton active={activePage === 1} label="扫码连接" onPress={() => selectPage(1)}/>
        </View>
      </View>

      <View style={[styles.pagerViewport, {width: pageWidth, height: pagerHeight}]}>
        <ScrollView
          bounces={false}
          horizontal
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
                      {borderColor: isActive ? theme.text : theme.textSecondary},
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
                  backgroundColor: theme.backgroundSelected,
                },
                pressed && styles.confirmButtonPressed,
              ]}>
              <Text
                style={[
                  styles.confirmText,
                  !isCodeComplete && {color: theme.textSecondary},
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
                          top: SCAN_FRAME_INSET,
                        },
                      ]}>
                      <View style={styles.scanLineGlow}/>
                      <View style={styles.scanLine}/>
                    </Animated.View>
                  </View>
                </View>
              </View>
            ) : (
              <CameraPermissionContent onAuthorize={handleAuthorizeCamera}/>
            )}
          </View>
        </ScrollView>
      </View>
    </View>
  )
}

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
          active && styles.segmentLabelActive,
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
          pressed && styles.pressed,
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
          pressed && styles.confirmButtonPressed,
        ]}>
        <Text style={styles.permissionButtonText}>立即授权</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    paddingBottom: 12,
    paddingTop: 2,
    width: '100%',
  },
  segmentContent: {
    paddingHorizontal: PAGE_HORIZONTAL_PADDING,
  },
  segmentTrack: {
    borderRadius: 12,
    flexDirection: 'row',
    height: 42,
    padding: SEGMENT_PADDING,
    position: 'relative',
  },
  segmentIndicator: {
    borderRadius: 9,
    bottom: SEGMENT_PADDING,
    left: SEGMENT_PADDING,
    position: 'absolute',
    top: SEGMENT_PADDING,
  },
  segmentButton: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    zIndex: 1,
  },
  segmentLabel: {
    fontSize: 15,
  },
  segmentLabelActive: {
    fontWeight: '700',
  },
  pagerViewport: {
    marginTop: 16,
    overflow: 'hidden',
  },
  pager: {},
  pagerContent: {},
  page: {
    flexShrink: 0,
    paddingBottom: 1,
    paddingHorizontal: PAGE_HORIZONTAL_PADDING,
  },
  codeRow: {
    flexDirection: 'row',
    gap: 10,
  },
  codeCell: {
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 2,
    flex: 1,
    height: 54,
    justifyContent: 'center',
    minWidth: 0,
  },
  codeDigit: {
    fontSize: 27,
    fontWeight: '700',
  },
  keypad: {
    gap: 8,
    marginTop: 20,
  },
  keypadRow: {
    flexDirection: 'row',
    gap: 10,
  },
  keypadCell: {
    flex: 1,
    height: 48,
    minWidth: 0,
  },
  keypadButton: {
    alignItems: 'center',
    borderRadius: 12,
    flex: 1,
    justifyContent: 'center',
  },
  keypadLabel: {
    fontSize: 17,
    fontWeight: '500',
  },
  deleteButton: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.6,
  },
  confirmButton: {
    alignItems: 'center',
    backgroundColor: '#050505',
    borderRadius: 27,
    height: 54,
    justifyContent: 'center',
    marginTop: 'auto',
  },
  confirmButtonPressed: {
    opacity: 0.78,
  },
  confirmText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  cameraViewport: {
    backgroundColor: '#111111',
    borderRadius: 16,
    flex: 1,
    overflow: 'hidden',
  },
  scanOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanFrame: {
    position: 'relative',
  },
  scanCorner: {
    borderColor: '#FFFFFF',
    height: 32,
    position: 'absolute',
    width: 32,
  },
  scanCornerTopLeft: {
    borderLeftWidth: 3,
    borderTopWidth: 3,
    left: 0,
    top: 0,
  },
  scanCornerTopRight: {
    borderRightWidth: 3,
    borderTopWidth: 3,
    right: 0,
    top: 0,
  },
  scanCornerBottomLeft: {
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    bottom: 0,
    left: 0,
  },
  scanCornerBottomRight: {
    borderBottomWidth: 3,
    borderRightWidth: 3,
    bottom: 0,
    right: 0,
  },
  scanLineContainer: {
    alignItems: 'center',
    height: 10,
    justifyContent: 'center',
    position: 'absolute',
  },
  scanLineGlow: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(105, 240, 160, 0.2)',
    borderRadius: 5,
  },
  scanLine: {
    backgroundColor: '#69F0A0',
    borderRadius: 1,
    height: 2,
    width: '100%',
  },
  permissionContent: {
    alignItems: 'center',
    flex: 1,
  },
  permissionIcon: {
    alignItems: 'center',
    borderRadius: 20,
    height: 96,
    justifyContent: 'center',
    width: 96,
  },
  permissionTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginTop: 20,
  },
  permissionDescription: {
    fontSize: 16,
    lineHeight: 23,
    marginTop: 8,
    maxWidth: 330,
    textAlign: 'center',
  },
  permissionButton: {
    alignItems: 'center',
    alignSelf: 'stretch',
    backgroundColor: '#050505',
    borderRadius: 27,
    height: 54,
    justifyContent: 'center',
    marginTop: 'auto',
  },
  permissionButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
})
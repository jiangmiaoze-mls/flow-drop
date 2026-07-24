import type {ComponentType, PropsWithChildren} from 'react'
import type {StyleProp, ViewProps, ViewStyle} from 'react-native'
import {StyleSheet, View} from 'react-native'

import {PAGE_HORIZONTAL_PADDING} from '@/constants/layout'

type HeaderProps = PropsWithChildren<{
  style?: StyleProp<ViewStyle>
}>

type HeaderSlotProps = ViewProps

function HeaderRoot({children, style}: HeaderProps) {
  return <View style={[styles.root, style]}>{children}</View>
}

function HeaderLeft({style, ...props}: HeaderSlotProps) {
  return <View {...props} style={[styles.slot, styles.left, style]}/>
}

function HeaderCenter({style, ...props}: HeaderSlotProps) {
  return <View pointerEvents="box-none" {...props} style={[styles.slot, styles.center, style]}/>
}

function HeaderRight({style, ...props}: HeaderSlotProps) {
  return <View {...props} style={[styles.slot, styles.right, style]}/>
}

type HeaderComponent = ComponentType<HeaderProps> & {
  Left: typeof HeaderLeft
  Center: typeof HeaderCenter
  Right: typeof HeaderRight
}

export const Header = Object.assign(HeaderRoot, {
  Left: HeaderLeft,
  Center: HeaderCenter,
  Right: HeaderRight,
}) as HeaderComponent

const styles = StyleSheet.create({
  root: {
    height: 56,
    position: 'relative',
    width: '100%',
  },
  slot: {
    bottom: 0,
    justifyContent: 'center',
    position: 'absolute',
    top: 0,
  },
  left: {
    alignItems: 'flex-start',
    left: PAGE_HORIZONTAL_PADDING,
    zIndex: 1,
  },
  center: {
    alignItems: 'center',
    left: PAGE_HORIZONTAL_PADDING,
    right: PAGE_HORIZONTAL_PADDING,
  },
  right: {
    alignItems: 'flex-end',
    right: PAGE_HORIZONTAL_PADDING,
    zIndex: 1,
  },
})

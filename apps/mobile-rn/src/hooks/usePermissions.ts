import {type PermissionResponse as CameraPermissionResponse, useCameraPermissions} from 'expo-camera'
import * as Location from 'expo-location'
import {PermissionStatus} from 'expo-location'
import {useCallback, useEffect, useRef} from 'react'
import {AppState, Linking} from 'react-native'

import {type ManagedPermission, usePermissionsStore} from '@/store/usePermissionsStore'

type NativePermissionResponse = Pick<CameraPermissionResponse, 'status'>

function toManagedPermission(response: NativePermissionResponse): ManagedPermission {
  return {
    resolved: true,
    status: response.status as PermissionStatus,
  }
}

export const useAccessFineLocationPermission = () => {
  const locationPermission = usePermissionsStore(state => state.location)
  const setLocationPermission = usePermissionsStore(state => state.setLocationPermission)

  const updateLocationPermission = useCallback((response: Location.LocationPermissionResponse) => {
    const permission = toManagedPermission(response)
    setLocationPermission(permission)
    return permission
  }, [setLocationPermission])

  const checkAccessFineLocationPermission = useCallback(async () => {
    const response = await Location.getForegroundPermissionsAsync()
    return updateLocationPermission(response)
  }, [updateLocationPermission])

  const requestAccessFineLocationPermission = useCallback(async () => {
    const response = await Location.requestForegroundPermissionsAsync()
    return updateLocationPermission(response)
  }, [updateLocationPermission])

  const requestAccessFineLocationPermissionIfNeeded = useCallback(async () => {
    const permission = await checkAccessFineLocationPermission()

    if (permission.status === PermissionStatus.UNDETERMINED) {
      return requestAccessFineLocationPermission()
    }

    return permission
  }, [checkAccessFineLocationPermission, requestAccessFineLocationPermission])

  const openLocationPermissionSettings = useCallback(() => Linking.openSettings(), [])

  return {
    checkAccessFineLocationPermission,
    isLocationPermissionGranted: locationPermission.status === PermissionStatus.GRANTED,
    locationPermission,
    openLocationPermissionSettings,
    requestAccessFineLocationPermission,
    requestAccessFineLocationPermissionIfNeeded,
  }
}

export const useCameraPermission = () => {
  const [nativeCameraPermission, requestNativeCameraPermission, getNativeCameraPermission] = useCameraPermissions()
  const hasCheckedInitialPermission = useRef(false)
  const cameraPermission = usePermissionsStore(state => state.camera)
  const setCameraPermission = usePermissionsStore(state => state.setCameraPermission)

  const updateCameraPermission = useCallback((response: NativePermissionResponse) => {
    const permission = toManagedPermission(response)
    setCameraPermission(permission)
    return permission
  }, [setCameraPermission])

  const checkCameraPermission = useCallback(async () => {
    const response = await getNativeCameraPermission()
    return updateCameraPermission(response)
  }, [getNativeCameraPermission, updateCameraPermission])

  const requestCameraPermission = useCallback(async () => {
    const response = await requestNativeCameraPermission()
    return updateCameraPermission(response)
  }, [requestNativeCameraPermission, updateCameraPermission])

  const requestCameraPermissionForScanner = useCallback(async () => {
    const permission = await checkCameraPermission()

    if (permission.status === PermissionStatus.UNDETERMINED) {
      return requestCameraPermission()
    }

    return permission
  }, [checkCameraPermission, requestCameraPermission])

  const authorizeCameraPermission = useCallback(async () => {
    const permission = await checkCameraPermission()

    if (permission.status === PermissionStatus.UNDETERMINED) {
      return requestCameraPermission()
    }

    await Linking.openSettings()
    return permission
  }, [checkCameraPermission, requestCameraPermission])

  useEffect(() => {
    if (nativeCameraPermission) {
      updateCameraPermission(nativeCameraPermission)
    }
  }, [nativeCameraPermission, updateCameraPermission])

  useEffect(() => {
    if (hasCheckedInitialPermission.current) return

    hasCheckedInitialPermission.current = true
    void checkCameraPermission()
  }, [checkCameraPermission])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void checkCameraPermission()
      }
    })

    return () => subscription.remove()
  }, [checkCameraPermission])

  return {
    authorizeCameraPermission,
    cameraPermission,
    checkCameraPermission,
    requestCameraPermission,
    requestCameraPermissionForScanner,
  }
}

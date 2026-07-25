import * as Location from 'expo-location'
import {PermissionStatus} from 'expo-location'
import {useCallback, useState} from 'react'

type AccessFineLocationPermission = {
  accessFineLocationAuthorize: boolean
  accessFineLocationGranted: PermissionStatus
}

const INITIAL_PERMISSION: AccessFineLocationPermission = {
  accessFineLocationAuthorize: false,
  accessFineLocationGranted: PermissionStatus.UNDETERMINED,
}

export const useAccessFineLocationPermission = () => {
  const [permission, setPermission] = useState<AccessFineLocationPermission>(INITIAL_PERMISSION)

  const updatePermission = useCallback((result: Location.LocationPermissionResponse) => {
    const nextPermission = {
      accessFineLocationAuthorize: result.granted,
      accessFineLocationGranted: result.status,
    }

    setPermission(nextPermission)
    return nextPermission
  }, [])

  const requestAccessFineLocationPermission = useCallback(async () => {
    const result = await Location.requestForegroundPermissionsAsync()
    return updatePermission(result)
  }, [updatePermission])

  const checkAccessFineLocationPermission = useCallback(async () => {
    const result = await Location.getForegroundPermissionsAsync()
    return updatePermission(result)
  }, [updatePermission])

  return {
    ...permission,
    checkAccessFineLocationPermission,
    requestAccessFineLocationPermission,
  }
}

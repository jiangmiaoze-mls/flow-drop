import {create} from 'zustand/react'
import {PermissionStatus} from 'expo-location'


interface PermissionsSate {
  accessFineLocationAuthorize: boolean
  accessFineLocationGranted: PermissionStatus
  setAccessFineLocation: (obj: {
    accessFineLocationAuthorize?: boolean,
    accessFineLocationGranted?: PermissionStatus
  }) => void

}

export const usePermissionsStore = create<PermissionsSate>((setState, getState) => ({
  accessFineLocationAuthorize: false,
  accessFineLocationGranted: PermissionStatus.UNDETERMINED,
  setAccessFineLocation: ({accessFineLocationAuthorize, accessFineLocationGranted}) => {
    setState({
      accessFineLocationAuthorize: accessFineLocationAuthorize ?? getState().accessFineLocationAuthorize,
      accessFineLocationGranted: accessFineLocationGranted ?? getState().accessFineLocationGranted
    })
  }
}))

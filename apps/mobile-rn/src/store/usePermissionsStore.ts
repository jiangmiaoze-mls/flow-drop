import {PermissionStatus} from 'expo-location'
import {create} from 'zustand/react'

export type ManagedPermission = {
  resolved: boolean
  status: PermissionStatus
}

const INITIAL_PERMISSION: ManagedPermission = {
  resolved: false,
  status: PermissionStatus.UNDETERMINED,
}

type PermissionsState = {
  camera: ManagedPermission
  location: ManagedPermission
  setCameraPermission: (permission: ManagedPermission) => void
  setLocationPermission: (permission: ManagedPermission) => void
}

export const usePermissionsStore = create<PermissionsState>((set) => ({
  camera: INITIAL_PERMISSION,
  location: INITIAL_PERMISSION,
  setCameraPermission: (camera) => set({camera}),
  setLocationPermission: (location) => set({location}),
}))

import {create} from 'zustand/react'

import type {TrustedDevice} from '@flowdrop/types'
import {
  deleteTrustedDevice,
  listTrustedDevices,
  setTrustedDeviceReceiveEnabled,
  upsertTrustedDevice
} from '@/storage/trustedDeviceRepository'


type TrustedDevicesState = {
  devices: TrustedDevice[]
  isLoaded: boolean
  load: () => void
  remove: (deviceId: string) => void
  save: (device: TrustedDevice) => void
  setReceiveEnabled: (deviceId: string, receiveEnabled: boolean) => void
}

export const useTrustedDevicesStore = create<TrustedDevicesState>((set) => ({
  devices: [],
  isLoaded: false,
  load: () => set({devices: listTrustedDevices(), isLoaded: true}),
  remove: (deviceId) => {
    deleteTrustedDevice(deviceId)
    set((state) => ({devices: state.devices.filter((device) => device.deviceId !== deviceId)}))
  },
  save: (device) => {
    const savedDevice = upsertTrustedDevice(device)
    set((state) => {
      const otherDevices = state.devices.filter((item) => item.deviceId !== savedDevice.deviceId)
      return {
        devices: [...otherDevices, savedDevice].sort((left, right) => left.deviceName.localeCompare(right.deviceName))
      }
    })
  },
  setReceiveEnabled: (deviceId, receiveEnabled) => {
    const updatedDevice = setTrustedDeviceReceiveEnabled(deviceId, receiveEnabled)
    if (!updatedDevice) return

    set((state) => ({
      devices: state.devices.map((device) => (
        device.deviceId === updatedDevice.deviceId ? updatedDevice : device
      ))
    }))
  }
}))

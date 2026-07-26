import * as SecureStore from 'expo-secure-store'


const KEY_PREFIX = 'flowdrop.transfer-secret.'

export async function getTransferSecret(deviceId: string): Promise<string | null> {
  return SecureStore.getItemAsync(`${KEY_PREFIX}${deviceId}`)
}

export async function setTransferSecret(deviceId: string, secret: string) {
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error('Invalid transfer credential.')
  await SecureStore.setItemAsync(`${KEY_PREFIX}${deviceId}`, secret, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
  })
}

export async function deleteTransferSecret(deviceId: string) {
  await SecureStore.deleteItemAsync(`${KEY_PREFIX}${deviceId}`)
}

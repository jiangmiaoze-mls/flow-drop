'use strict'

const {requireOptionalNativeModule} = require('expo-modules-core')

const FlowDropNetwork = requireOptionalNativeModule('FlowDropNetwork')

async function getWifiIPv4BroadcastTargetAsync() {
  if (!FlowDropNetwork) return null
  return FlowDropNetwork.getWifiIPv4BroadcastTargetAsync()
}

async function sha256FileAsync(uri, operationId) {
  if (!FlowDropNetwork || typeof FlowDropNetwork.sha256FileAsync !== 'function') return null
  return FlowDropNetwork.sha256FileAsync(uri, operationId)
}

function addSha256ProgressListener(listener) {
  if (!FlowDropNetwork || typeof FlowDropNetwork.addListener !== 'function') {
    return {remove() {}}
  }
  return FlowDropNetwork.addListener('sha256Progress', listener)
}

module.exports = {
  addSha256ProgressListener,
  sha256FileAsync,
  getWifiIPv4BroadcastTargetAsync
}

'use strict'

const {requireOptionalNativeModule} = require('expo-modules-core')

const FlowDropNetwork = requireOptionalNativeModule('FlowDropNetwork')

async function getWifiIPv4BroadcastTargetAsync() {
  if (!FlowDropNetwork) return null
  return FlowDropNetwork.getWifiIPv4BroadcastTargetAsync()
}

module.exports = {
  getWifiIPv4BroadcastTargetAsync
}

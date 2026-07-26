package com.flowdrop.network

import android.content.Context
import android.net.wifi.WifiManager
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class FlowDropNetworkModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("FlowDropNetwork")

    AsyncFunction("getWifiIPv4BroadcastTargetAsync") {
      val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        ?: return@AsyncFunction null
      val dhcpInfo = wifiManager.dhcpInfo ?: return@AsyncFunction null
      val address = dhcpInfo.ipAddress
      val netmask = dhcpInfo.netmask

      if (address == 0 || netmask == 0) return@AsyncFunction null

      mapOf(
        "address" to ipv4Address(address),
        "netmask" to ipv4Address(netmask),
        "broadcastAddress" to ipv4Address((address and netmask) or netmask.inv())
      )
    }
  }

  private fun ipv4Address(value: Int): String = listOf(
    value and 0xff,
    value shr 8 and 0xff,
    value shr 16 and 0xff,
    value shr 24 and 0xff
  ).joinToString(".")
}

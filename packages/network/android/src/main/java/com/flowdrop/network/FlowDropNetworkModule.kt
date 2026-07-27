package com.flowdrop.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.Inet4Address

class FlowDropNetworkModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("FlowDropNetwork")
    Events("transferState", "transferProgress", "transferFailure", "transferChunkDigests")

    AsyncFunction("getWifiIPv4BroadcastTargetAsync") {
      val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
      val dhcpInfo = wifiManager?.dhcpInfo
      val address = dhcpInfo?.ipAddress ?: 0
      val netmask = dhcpInfo?.netmask ?: 0

      if (address != 0 && netmask != 0) {
        return@AsyncFunction mapOf(
          "address" to ipv4Address(address),
          "netmask" to ipv4Address(netmask),
          "broadcastAddress" to ipv4Address((address and netmask) or netmask.inv())
        )
      }

      getActiveWifiIpv4Target()
    }

    AsyncFunction("startTransfer") Coroutine { config: Map<String, Any?> ->
      transferController().start(NativeTransferConfig.fromMap(config))
    }

    AsyncFunction("restartTransferForRecovery") Coroutine { config: Map<String, Any?> ->
      transferController().restartForRecovery(NativeTransferConfig.fromMap(config))
    }

    AsyncFunction("reconcileCancelledTransfer") Coroutine { config: Map<String, Any?> ->
      transferController().reconcileCancelledTransfer(NativeTransferConfig.fromMap(config))
    }

    AsyncFunction("retainTransferSourceUris") Coroutine { sourceUris: List<String> ->
      transferController().retainSourceUriPermissions(sourceUris)
    }

    AsyncFunction("pauseTransfer") Coroutine { transferId: String ->
      transferController().pause(transferId)
    }

    AsyncFunction("resumeTransfer") Coroutine { transferId: String ->
      transferController().resume(transferId)
    }

    AsyncFunction("cancelTransfer") Coroutine { transferId: String ->
      transferController().cancel(transferId)
    }

    AsyncFunction("getTransferSnapshot") { transferId: String ->
      transferController().snapshot(transferId)
    }

  }

  private fun transferController(): TransferController {
    return TransferControllerRegistry.get(context.applicationContext) { eventName, payload ->
      sendEvent(eventName, payload)
    }
  }

  private fun getActiveWifiIpv4Target(): Map<String, String>? {
    val connectivityManager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
      ?: return null
    val network = connectivityManager.activeNetwork ?: return null
    val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return null
    if (!capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return null

    val linkAddress = connectivityManager.getLinkProperties(network)
      ?.linkAddresses
      ?.firstOrNull { it.address is Inet4Address && !it.address.isLoopbackAddress }
      ?: return null
    val prefixLength = linkAddress.prefixLength
    if (prefixLength !in 0..32) return null

    val address = ipv4ToLong(linkAddress.address as Inet4Address)
    val netmask = if (prefixLength == 0) 0 else (0xffffffffL shl (32 - prefixLength)) and 0xffffffffL
    val broadcastAddress = address or (netmask xor 0xffffffffL)

    return mapOf(
      "address" to ipv4Address(address),
      "netmask" to ipv4Address(netmask),
      "broadcastAddress" to ipv4Address(broadcastAddress)
    )
  }

  private fun ipv4Address(value: Int): String = listOf(
    value and 0xff,
    value shr 8 and 0xff,
    value shr 16 and 0xff,
    value shr 24 and 0xff
  ).joinToString(".")

  private fun ipv4Address(value: Long): String = listOf(
    (value shr 24) and 0xff,
    (value shr 16) and 0xff,
    (value shr 8) and 0xff,
    value and 0xff
  ).joinToString(".")

  private fun ipv4ToLong(address: Inet4Address): Long = address.address.fold(0L) { value, byte ->
    (value shl 8) or (byte.toInt() and 0xff).toLong()
  }
}

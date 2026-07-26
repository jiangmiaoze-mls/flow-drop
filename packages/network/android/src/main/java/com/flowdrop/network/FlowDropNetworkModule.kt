package com.flowdrop.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.net.wifi.WifiManager
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.Inet4Address
import java.security.MessageDigest

class FlowDropNetworkModule : Module() {
  private companion object {
    const val HASH_BUFFER_BYTES = 1024 * 1024
    const val HASH_PROGRESS_STEP_BYTES = 4L * 1024 * 1024
  }

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("FlowDropNetwork")
    Events("sha256Progress")

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

    AsyncFunction("sha256FileAsync") Coroutine { uriString: String, operationId: String ->
      hashFile(uriString, operationId)
    }
  }

  private suspend fun hashFile(uriString: String, operationId: String): Map<String, Any> = withContext(Dispatchers.IO) {
    val uri = Uri.parse(uriString)
    val totalBytes = getFileSize(uri)
    val digest = MessageDigest.getInstance("SHA-256")
    var processedBytes = 0L
    var lastReportedBytes = 0L
    val input = context.contentResolver.openInputStream(uri)
      ?: throw IllegalArgumentException("Unable to read selected file")

    input.use { stream ->
      val buffer = ByteArray(HASH_BUFFER_BYTES)
      while (true) {
        val read = stream.read(buffer)
        if (read < 0) break
        if (read == 0) continue
        digest.update(buffer, 0, read)
        processedBytes += read
        if (processedBytes - lastReportedBytes >= HASH_PROGRESS_STEP_BYTES) {
          lastReportedBytes = processedBytes
          sendEvent("sha256Progress", mapOf(
            "operationId" to operationId,
            "processedBytes" to processedBytes,
            "totalBytes" to if (totalBytes >= 0) totalBytes else processedBytes
          ))
        }
      }
    }

    sendEvent("sha256Progress", mapOf(
      "operationId" to operationId,
      "processedBytes" to processedBytes,
      "totalBytes" to processedBytes
    ))
    mapOf(
      "sha256" to digest.digest().joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) },
      "sizeBytes" to processedBytes
    )
  }

  private fun getFileSize(uri: Uri): Long {
    if (uri.scheme == "file") return File(requireNotNull(uri.path)).length()
    return context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { descriptor -> descriptor.length } ?: -1L
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

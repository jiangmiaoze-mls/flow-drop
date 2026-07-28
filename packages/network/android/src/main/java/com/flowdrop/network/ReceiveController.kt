package com.flowdrop.network

import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

private const val RECEIVE_BUFFER_BYTES = 64 * 1024
private const val RECEIVE_RETRY_COUNT = 3
private const val INCOMING_DIRECTORY = "flowdrop-v3-incoming"
private const val MANAGED_FILES_DIRECTORY = "flowdrop-managed-files"

data class NativeIncomingItem(
  val contentRoot: String,
  val itemId: String,
  val mimeType: String,
  val name: String,
  val sizeBytes: Long
)

data class NativeIncomingTransferConfig(
  val chunkSizeBytes: Int,
  val items: List<NativeIncomingItem>,
  val peerAddress: String,
  val peerControlPort: Int,
  val recipientDeviceId: String,
  val revision: Long,
  val transferId: String,
  val transferSecretHex: String
) {
  companion object {
    fun fromMap(value: Map<String, Any?>): NativeIncomingTransferConfig {
      val transferId = requiredIdentifier(value, "transferId")
      val recipientDeviceId = requiredIdentifier(value, "recipientDeviceId")
      val peerAddress = requiredString(value, "peerAddress")
      val peerControlPort = requiredLong(value, "peerControlPort")
      val revision = requiredLong(value, "revision")
      val chunkSizeBytes = requiredLong(value, "chunkSizeBytes")
      val secret = requiredString(value, "transferSecretHex")
      val rawItems = value["items"] as? List<*> ?: throw IllegalArgumentException("Incoming transfer items are required.")
      require(peerAddress.isNotBlank() && peerAddress.none(Char::isWhitespace)) { "Invalid peer address." }
      require(peerControlPort in 1L..65_535L && revision >= 0L) { "Invalid incoming transfer endpoint." }
      require(chunkSizeBytes in V3TransferProtocol.MIN_CHUNK_BYTES.toLong()..V3TransferProtocol.MAX_CHUNK_BYTES.toLong()) { "Invalid incoming chunk size." }
      require(secret.matches(Regex("^[a-fA-F0-9]{64}$"))) { "Invalid incoming transfer credential." }
      require(rawItems.size in 1..32) { "Invalid incoming transfer item count." }
      val seenIds = mutableSetOf<String>()
      val items = rawItems.map { raw ->
        val item = raw as? Map<*, *> ?: throw IllegalArgumentException("Invalid incoming transfer item.")
        val itemId = requiredIdentifier(item, "itemId")
        val name = requiredString(item, "name")
        val mimeType = requiredString(item, "mimeType")
        val sizeBytes = requiredLong(item, "sizeBytes")
        val contentRoot = requiredString(item, "contentRoot")
        require(seenIds.add(itemId) && sizeBytes >= 0L && sizeBytes <= 9_007_199_254_740_991L) { "Invalid incoming transfer item." }
        require(name.isNotBlank() && name.length <= 255 && !name.any { it in "<>:\"/\\|?*" || it.code < 32 }) { "Invalid incoming file name." }
        require(mimeType.matches(Regex("^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$"))) { "Invalid incoming MIME type." }
        require(contentRoot.matches(Regex("^[a-f0-9]{64}$"))) { "Invalid incoming content root." }
        NativeIncomingItem(contentRoot, itemId, mimeType, name, sizeBytes)
      }
      return NativeIncomingTransferConfig(chunkSizeBytes.toInt(), items, peerAddress, peerControlPort.toInt(), recipientDeviceId, revision, transferId, secret)
    }

    private fun requiredString(value: Map<*, *>, key: String) = value[key] as? String ?: throw IllegalArgumentException("Missing $key.")
    private fun requiredIdentifier(value: Map<*, *>, key: String): String = requiredString(value, key).also {
      require(it.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"))) { "Invalid $key." }
    }
    private fun requiredLong(value: Map<*, *>, key: String): Long = when (val raw = value[key]) {
      is Int -> raw.toLong()
      is Long -> raw
      is Double -> raw.toLong().takeIf { raw.isFinite() && raw == it.toDouble() }
      else -> null
    } ?: throw IllegalArgumentException("Missing $key.")
  }
}

private data class IncomingRecord(
  val config: NativeIncomingTransferConfig,
  var confirmedBytes: Long = 0,
  var errorCode: String? = null,
  var job: Job? = null,
  val localUris: MutableMap<String, String> = mutableMapOf(),
  var revision: Long = config.revision,
  var status: String = "transferring"
)

/**
 * Downloads Agent-originated bytes without involving the React bridge. A part
 * file may be re-used after a reconnect, but every resumed chunk is fetched
 * and ACKed again so the Agent remains the authority for durable progress.
 */
class ReceiveController(
  private val context: Context,
  private var eventSink: ((String, Map<String, Any>) -> Unit)? = null
) {
  private val client = OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).build()
  private val records = ConcurrentHashMap<String, IncomingRecord>()
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  fun setEventSink(sink: (String, Map<String, Any>) -> Unit) {
    eventSink = sink
  }

  fun start(config: NativeIncomingTransferConfig): String {
    val current = records[config.transferId]
    if (current != null) return current.config.transferId
    val record = IncomingRecord(config)
    records[config.transferId] = record
    emitState(record)
    startDownload(record)
    return config.transferId
  }

  suspend fun resume(transferId: String) {
    val record = records[transferId] ?: return
    if (record.status != "paused") return
    postControl(record, "resume")
    record.status = "transferring"
    record.errorCode = null
    emitState(record)
    startDownload(record)
  }

  private fun startDownload(record: IncomingRecord) {
    record.job = scope.launch {
      try {
        download(record)
      } catch (error: CancellationException) {
        throw error
      } catch (error: Throwable) {
        deleteTransferFiles(record.config)
        record.status = "failed"
        record.errorCode = error.message?.takeIf { it.matches(Regex("[A-Z][A-Z0-9_]{2,}")) } ?: "INCOMING_TRANSFER_FAILED"
        emitFailure(record)
        emitState(record)
      }
    }
  }

  suspend fun pause(transferId: String) {
    val record = records[transferId] ?: return
    if (record.status != "transferring") return
    record.job?.cancel()
    try {
      postControl(record, "pause")
      record.status = "paused"
      emitState(record)
    } catch (error: Throwable) {
      record.status = "failed"
      record.errorCode = error.message ?: "INCOMING_CONTROL_FAILED"
      emitFailure(record)
      emitState(record)
      throw error
    }
  }

  suspend fun cancel(transferId: String) {
    val record = records[transferId] ?: return
    try {
      postControl(record, "cancel")
    } catch (error: Throwable) {
      record.status = "failed"
      record.errorCode = error.message ?: "INCOMING_CONTROL_FAILED"
      emitFailure(record)
      emitState(record)
      throw error
    }
    records.remove(transferId)
    record.job?.cancel()
    deleteTransferFiles(record.config)
    record.status = "cancelled"
    emitState(record)
  }

  fun snapshots(): List<Map<String, Any>> = records.values.map { snapshot(it) }

  private suspend fun download(record: IncomingRecord) {
    val config = record.config
    for ((itemOrdinal, item) in config.items.withIndex()) {
      val part = partFile(config, item)
      part.parentFile?.mkdirs()
      if (!part.exists() && !part.createNewFile()) throw IllegalStateException("PART_WRITE_ERROR")
      val chunks = V3TransferProtocol.chunkCount(item.sizeBytes, config.chunkSizeBytes)
      var deferredFinalAcknowledgement: Pair<Int, String>? = null
      for (index in 0 until chunks) {
        val isLastTransferChunk = itemOrdinal == config.items.lastIndex && index == chunks - 1
        val digest = downloadChunkWithRetries(record, item, index, part)
        if (isLastTransferChunk) {
          // Keep the Agent transfer recoverable until the complete payload has
          // passed its content-root check and has been atomically published.
          deferredFinalAcknowledgement = index to digest
        } else {
          acknowledgeChunk(record, item, index, digest)
          recordConfirmedChunk(record, item, index)
        }
      }
      val root = calculatePartContentRoot(part, item.sizeBytes, config.chunkSizeBytes)
      if (root != item.contentRoot) throw IllegalStateException("CONTENT_ROOT_MISMATCH")
      val final = finalFile(config, item)
      final.parentFile?.mkdirs()
      if (final.exists() && !final.delete()) throw IllegalStateException("PART_WRITE_ERROR")
      if (!part.renameTo(final)) throw IllegalStateException("PART_WRITE_ERROR")
      record.localUris[item.itemId] = Uri.fromFile(final).toString()
      deferredFinalAcknowledgement?.let { (index, digest) ->
        acknowledgeChunk(record, item, index, digest)
        recordConfirmedChunk(record, item, index)
      }
    }
    record.status = "completed"
    record.errorCode = null
    emitState(record)
  }

  private suspend fun downloadChunkWithRetries(record: IncomingRecord, item: NativeIncomingItem, index: Int, part: File): String {
    var lastError: Throwable? = null
    repeat(RECEIVE_RETRY_COUNT) {
      try {
        return downloadChunk(record, item, index, part)
      } catch (error: Throwable) {
        if (error is CancellationException) throw error
        lastError = error
      }
    }
    throw lastError ?: IllegalStateException("INCOMING_CHUNK_FAILED")
  }

  private fun recordConfirmedChunk(record: IncomingRecord, item: NativeIncomingItem, index: Int) {
    record.confirmedBytes += V3TransferProtocol.expectedChunkLength(item.sizeBytes, record.config.chunkSizeBytes, index)
    emitState(record)
  }

  private suspend fun downloadChunk(record: IncomingRecord, item: NativeIncomingItem, index: Int, part: File): String = withContext(Dispatchers.IO) {
    val config = record.config
    val expectedLength = V3TransferProtocol.expectedChunkLength(item.sizeBytes, config.chunkSizeBytes, index)
    val path = "/v3/outgoing-transfers/${config.transferId}/items/${item.itemId}/chunks/$index"
    val request = signedRequest(config, "GET", path, ByteArray(0), null)
    client.newCall(request).execute().use { response ->
      if (!response.isSuccessful) throw IllegalStateException(errorCode(response.body?.string()))
      val range = response.header("content-range") ?: throw IllegalStateException("INVALID_CONTENT_RANGE")
      val expectedStart = index.toLong() * config.chunkSizeBytes
      if (range != "bytes $expectedStart-${expectedStart + expectedLength - 1}/${item.sizeBytes}") throw IllegalStateException("INVALID_CONTENT_RANGE")
      val advertisedDigest = response.header("x-flowdrop-chunk-sha256") ?: throw IllegalStateException("INVALID_CHUNK")
      val digest = MessageDigest.getInstance("SHA-256")
      RandomAccessFile(part, "rw").use { output ->
        output.seek(expectedStart)
        response.body?.byteStream()?.use { input ->
          val buffer = ByteArray(RECEIVE_BUFFER_BYTES)
          var total = 0
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            if (total > expectedLength) throw IllegalStateException("INVALID_CHUNK")
            digest.update(buffer, 0, count)
            output.write(buffer, 0, count)
          }
          if (total != expectedLength) throw IllegalStateException("INVALID_CHUNK")
        } ?: throw IllegalStateException("INVALID_CHUNK")
      }
      val actual = digest.digest().toV3LowerHex()
      if (actual != advertisedDigest || !advertisedDigest.matches(Regex("^[a-f0-9]{64}$"))) throw IllegalStateException("CHUNK_HASH_MISMATCH")
      actual
    }
  }

  private suspend fun acknowledgeChunk(record: IncomingRecord, item: NativeIncomingItem, index: Int, sha256: String) = withContext(Dispatchers.IO) {
    val sizeBytes = V3TransferProtocol.expectedChunkLength(item.sizeBytes, record.config.chunkSizeBytes, index)
    val body = "{\"sha256\":\"$sha256\",\"sizeBytes\":$sizeBytes}".toByteArray(Charsets.UTF_8)
    val path = "/v3/outgoing-transfers/${record.config.transferId}/items/${item.itemId}/chunks/$index/ack"
    val request = signedRequest(record.config, "POST", path, body, "application/json".toMediaType())
    client.newCall(request).execute().use { response ->
      if (!response.isSuccessful) throw IllegalStateException(errorCode(response.body?.string()))
      val payload = JSONObject(response.body?.string().orEmpty())
      record.revision = maxOf(record.revision, payload.optLong("revision", record.revision))
    }
  }

  private suspend fun postControl(record: IncomingRecord, operation: String) = withContext(Dispatchers.IO) {
    val path = "/v3/outgoing-transfers/${record.config.transferId}/$operation"
    val request = signedRequest(record.config, "POST", path, ByteArray(0), null)
    client.newCall(request).execute().use { response ->
      if (!response.isSuccessful) throw IllegalStateException(errorCode(response.body?.string()))
      val payload = JSONObject(response.body?.string().orEmpty())
      record.revision = maxOf(record.revision, payload.optLong("revision", record.revision))
    }
  }

  private fun signedRequest(config: NativeIncomingTransferConfig, method: String, path: String, body: ByteArray, mediaType: okhttp3.MediaType?): Request {
    val authorization = V3TransferProtocol.authorization(config.transferSecretHex, method, path, body)
    val url = v3HttpUrl(config.peerAddress, config.peerControlPort, path)
    return Request.Builder().url(url).method(method, if (method == "GET") null else body.toRequestBody(mediaType)).apply {
      header("authorization", authorization)
      header("x-flowdrop-source-device-id", config.recipientDeviceId)
    }.build()
  }

  private fun calculatePartContentRoot(part: File, sizeBytes: Long, chunkSizeBytes: Int): String {
    if (!part.exists() || part.length() != sizeBytes) throw IllegalStateException("PART_READ_ERROR")
    val chunks = ArrayList<V3ChunkDigest>()
    FileInputStream(part).use { input ->
      val count = V3TransferProtocol.chunkCount(sizeBytes, chunkSizeBytes)
      for (index in 0 until count) {
        val length = V3TransferProtocol.expectedChunkLength(sizeBytes, chunkSizeBytes, index)
        val digest = MessageDigest.getInstance("SHA-256")
        var remaining = length
        val buffer = ByteArray(minOf(RECEIVE_BUFFER_BYTES, length))
        while (remaining > 0) {
          val read = input.read(buffer, 0, minOf(buffer.size, remaining))
          if (read < 0) throw IllegalStateException("PART_READ_ERROR")
          digest.update(buffer, 0, read)
          remaining -= read
        }
        chunks.add(V3ChunkDigest(index, length, digest.digest()))
      }
    }
    return V3TransferProtocol.contentRoot(sizeBytes, chunkSizeBytes, chunks)
  }

  suspend fun deleteIncomingTransferFiles(transferId: String) = withContext(Dispatchers.IO) {
    require(transferId.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"))) { "Invalid transferId." }
    File(managedIncomingDirectory(), transferId).deleteRecursively()
    File(incomingStagingDirectory(), transferId).deleteRecursively()
  }

  fun cleanupLegacyTransferFiles() {
    File(context.filesDir, INCOMING_DIRECTORY).deleteRecursively()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      runCatching {
        context.contentResolver.delete(
          MediaStore.Downloads.EXTERNAL_CONTENT_URI,
          "${MediaStore.MediaColumns.RELATIVE_PATH} = ?",
          arrayOf("Download/FlowDrop/")
        )
      }
    }
  }

  private fun managedIncomingDirectory() = File(File(context.filesDir, MANAGED_FILES_DIRECTORY), "incoming")
  private fun incomingStagingDirectory() = File(File(File(context.filesDir, MANAGED_FILES_DIRECTORY), ".staging"), "incoming")
  private fun transferDirectory(config: NativeIncomingTransferConfig) = File(managedIncomingDirectory(), config.transferId)
  private fun partDirectory(config: NativeIncomingTransferConfig) = File(incomingStagingDirectory(), config.transferId)
  private fun partFile(config: NativeIncomingTransferConfig, item: NativeIncomingItem) = File(partDirectory(config), "${item.itemId}.part")
  private fun finalFile(config: NativeIncomingTransferConfig, item: NativeIncomingItem) = File(transferDirectory(config), "${item.itemId}-${item.name}")
  private fun deletePartDirectory(config: NativeIncomingTransferConfig) { partDirectory(config).deleteRecursively() }
  private fun deleteTransferFiles(config: NativeIncomingTransferConfig) {
    transferDirectory(config).deleteRecursively()
    deletePartDirectory(config)
  }

  private fun emitState(record: IncomingRecord) = dispatch("incomingTransferState", record)
  private fun emitFailure(record: IncomingRecord) = dispatch("incomingTransferFailure", record)
  private fun dispatch(name: String, record: IncomingRecord) {
    eventSink?.invoke(name, snapshot(record))
  }
  private fun snapshot(record: IncomingRecord): Map<String, Any> {
    val payload = mutableMapOf<String, Any>(
      "confirmedBytes" to record.confirmedBytes,
      "revision" to record.revision,
      "status" to record.status,
      "transferId" to record.config.transferId
    )
    record.errorCode?.let { payload["errorCode"] = it }
    if (record.localUris.isNotEmpty()) payload["localUris"] = record.localUris.toMap()
    return payload
  }
  private fun errorCode(body: String?): String {
    return try { JSONObject(body.orEmpty()).optString("code").takeIf { it.matches(Regex("[A-Z][A-Z0-9_]{2,}")) } ?: "INCOMING_REQUEST_FAILED" }
    catch (_: Throwable) { "INCOMING_REQUEST_FAILED" }
  }
}

object ReceiveControllerRegistry {
  private var controller: ReceiveController? = null
  @Synchronized fun get(context: Context, sink: (String, Map<String, Any>) -> Unit): ReceiveController {
    val result = controller ?: ReceiveController(context.applicationContext).also { controller = it }
    result.setEventSink(sink)
    return result
  }
}

package com.flowdrop.network

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.ComponentCallbacks2
import android.content.Intent
import android.content.res.Configuration
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkRequest
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.HttpUrl
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.coroutineContext
import kotlin.math.max

private const val PROGRESS_BYTES_STEP = 256L * 1024L
private const val PROGRESS_TIME_STEP_MS = 100L
private const val MAX_CHUNK_RETRIES = 3
private const val MAX_COMPLETION_RECONCILIATION_RESTARTS = 3
private const val MAX_ACTIVE_NATIVE_TRANSFERS = 2
private const val MAX_NATIVE_IN_FLIGHT_CHUNKS = 4
private const val STATUS_REPAIR_MIN_INTERVAL_MS = 5_000L
private const val STATUS_REPAIR_CALL_TIMEOUT_MS = 5_000L
private const val ACK_SILENCE_REPAIR_DELAY_MS = 1_000L
private const val ACK_MIN_REPAIR_DELAY_MS = 2_000L
private const val ACTIVITY_BACKGROUND_GRACE_MS = 250L
private const val INITIAL_RTT_MS = 500L
private const val STREAM_BUFFER_BYTES = 64 * 1024
private const val WINDOW_GROWTH_ACKS = 4
private const val WINDOW_WAIT_MS = 25L
private const val MAX_JS_SAFE_INTEGER = 9_007_199_254_740_991L
private const val MAX_TRANSFER_ITEMS = 32
private const val MAX_FILE_NAME_LENGTH = 255
private const val MAX_DIGEST_EVENT_BATCH = 1_000
private val RECOVERY_REPAIR_DELAYS_MS = longArrayOf(500L, 1_000L, 2_000L, 5_000L)

internal fun ackRepairThresholdMillis(roundTripTimeMs: Long): Long {
  val boundedRtt = roundTripTimeMs.coerceAtLeast(0L)
  val tripleRtt = if (boundedRtt > Long.MAX_VALUE / 3L) Long.MAX_VALUE else boundedRtt * 3L
  return max(ACK_MIN_REPAIR_DELAY_MS, tripleRtt)
}

data class NativeTransferItem(
  val itemId: String,
  val mimeType: String,
  val name: String,
  val sizeBytes: Long,
  val sourceUri: String
)

/**
 * Metadata restored from React Native SQLite. This deliberately contains no
 * file bytes: native owns all file access while JS persists only durable ACK
 * evidence for recovery reconciliation.
 */
data class NativePersistedChunkDigest(
  val confirmedRevision: Long?,
  val index: Int,
  val itemId: String,
  val length: Int,
  val sha256: ByteArray
)

data class NativeTransferConfig(
  val initialChunkSizeBytes: Int,
  val initialRevision: Long,
  val items: List<NativeTransferItem>,
  val peerAddress: String,
  val peerControlPort: Int,
  val recovering: Boolean,
  val sourceDeviceId: String,
  val transferId: String,
  val transferSecretHex: String,
  val persistedChunkDigests: List<NativePersistedChunkDigest> = emptyList()
) {
  companion object {
    fun fromMap(value: Map<String, Any?>): NativeTransferConfig {
      val peerAddress = requiredString(value, "peerAddress")
      val peerControlPortValue = requiredLong(value, "peerControlPort")
      val recovering = when {
        !value.containsKey("recovering") -> false
        value["recovering"] is Boolean -> value["recovering"] as Boolean
        else -> throw IllegalArgumentException("Invalid recovering flag.")
      }
      val sourceDeviceId = requiredString(value, "sourceDeviceId")
      val transferId = requiredString(value, "transferId")
      val transferSecretHex = requiredString(value, "transferSecretHex")
      val initialChunkSizeValue = optionalLong(value["initialChunkSizeBytes"])
        ?: V3TransferProtocol.DEFAULT_CHUNK_BYTES.toLong()
      val initialRevision = optionalLong(value["initialRevision"]) ?: 0L
      val rawItems = value["items"] as? List<*> ?: throw IllegalArgumentException("Transfer items are required.")

      require(rawItems.size in 1..MAX_TRANSFER_ITEMS) { "Invalid transfer item count." }
      require(peerControlPortValue in 1L..65_535L) { "Invalid peer control port." }
      require(peerAddress.isNotBlank() && peerAddress.none(Char::isWhitespace)) { "Invalid peer address." }
      require(isIdentifier(sourceDeviceId) && isIdentifier(transferId)) { "Invalid transfer identifier." }
      require(transferSecretHex.matches(Regex("^[a-fA-F0-9]{64}$"))) { "Invalid transfer credential." }
      require(initialChunkSizeValue in V3TransferProtocol.MIN_CHUNK_BYTES.toLong()..V3TransferProtocol.MAX_CHUNK_BYTES.toLong()) {
        "Invalid initial chunk size."
      }
      require(initialRevision >= 0L) { "Invalid initial revision." }

      val itemIds = mutableSetOf<String>()
      val items = rawItems.map { rawItem ->
        val item = rawItem as? Map<*, *> ?: throw IllegalArgumentException("Invalid transfer item.")
        val itemId = requiredString(item, "itemId")
        val name = requiredString(item, "name")
        val mimeType = requiredString(item, "mimeType")
        val sourceUri = requiredString(item, "sourceUri")
        val sizeBytes = requiredLong(item, "sizeBytes")
        require(isIdentifier(itemId) && itemIds.add(itemId)) { "Invalid transfer item ID." }
        require(sizeBytes in 0..MAX_JS_SAFE_INTEGER) { "Invalid transfer item size." }
        require(isFileName(name) && isMimeType(mimeType) && sourceUri.isNotBlank()) { "Invalid transfer item." }
        NativeTransferItem(itemId, mimeType, name, sizeBytes, sourceUri)
      }
      val persistedChunkDigests = parsePersistedChunkDigests(value["persistedChunkDigests"], itemIds)
      return NativeTransferConfig(
        initialChunkSizeBytes = initialChunkSizeValue.toInt(),
        initialRevision = initialRevision,
        items = items,
        peerAddress = peerAddress,
        peerControlPort = peerControlPortValue.toInt(),
        recovering = recovering,
        sourceDeviceId = sourceDeviceId,
        transferId = transferId,
        transferSecretHex = transferSecretHex,
        persistedChunkDigests = persistedChunkDigests
      )
    }

    private fun parsePersistedChunkDigests(
      value: Any?,
      itemIds: Set<String>
    ): List<NativePersistedChunkDigest> {
      if (value == null) return emptyList()
      val rawDigests = value as? List<*> ?: throw IllegalArgumentException("Invalid persisted chunk digests.")
      val identities = mutableSetOf<String>()
      return rawDigests.map { rawDigest ->
        val digest = rawDigest as? Map<*, *> ?: throw IllegalArgumentException("Invalid persisted chunk digest.")
        val itemId = requiredString(digest, "itemId")
        val index = requiredLong(digest, "index")
        val length = requiredLong(digest, "length")
        val sha256 = requiredString(digest, "sha256")
        val confirmedRevision = when {
          !digest.containsKey("confirmedRevision") || digest["confirmedRevision"] == null -> null
          else -> requiredLong(digest, "confirmedRevision")
        }

        require(itemId in itemIds) { "Invalid persisted chunk digest item ID." }
        require(index in 0..Int.MAX_VALUE.toLong()) { "Invalid persisted chunk digest index." }
        require(length in 1..Int.MAX_VALUE.toLong()) { "Invalid persisted chunk digest length." }
        require(confirmedRevision == null || confirmedRevision >= 0) { "Invalid persisted chunk digest revision." }
        require(sha256.matches(Regex("^[a-f0-9]{64}$"))) { "Invalid persisted chunk digest SHA-256." }
        require(identities.add("$itemId:$index")) { "Duplicate persisted chunk digest." }

        NativePersistedChunkDigest(
          confirmedRevision = confirmedRevision,
          index = index.toInt(),
          itemId = itemId,
          length = length.toInt(),
          sha256 = V3TransferProtocol.decodeHex(sha256)
        )
      }
    }

    private fun requiredString(value: Map<*, *>, key: String): String {
      return value[key] as? String ?: throw IllegalArgumentException("Missing $key.")
    }

    private fun requiredLong(value: Map<*, *>, key: String): Long {
      return optionalLong(value[key]) ?: throw IllegalArgumentException("Missing $key.")
    }

    private fun optionalLong(value: Any?): Long? {
      return when (value) {
        is Byte -> value.toLong()
        is Short -> value.toLong()
        is Int -> value.toLong()
        is Long -> value
        is Float -> value.toLong().takeIf {
          value.isFinite() && value >= -MAX_JS_SAFE_INTEGER && value <= MAX_JS_SAFE_INTEGER && value == it.toFloat()
        }
        is Double -> value.toLong().takeIf {
          value.isFinite() && value >= -MAX_JS_SAFE_INTEGER && value <= MAX_JS_SAFE_INTEGER && value == it.toDouble()
        }
        else -> null
      }
    }

    private fun isIdentifier(value: String) = value.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"))

    private fun isFileName(value: String): Boolean {
      return value.length in 1..MAX_FILE_NAME_LENGTH
        && value.trim().isNotEmpty()
        && value.none { character -> character == '<' || character == '>' || character == ':' || character == '"'
          || character == '/' || character == '\\' || character == '|' || character == '?' || character == '*'
          || character.code in 0..0x1f }
    }

    private fun isMimeType(value: String): Boolean {
      return value.length <= 127 && value.matches(Regex("^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$"))
    }
  }
}

private data class RemoteTransferSnapshot(
  val chunkSizeBytes: Int?,
  val errorCode: String?,
  val receivedRanges: Map<String, List<IntRange>>,
  val revision: Long,
  val status: String,
  val transferReceivedBytes: Long,
  val verifyingBytes: Long,
  val verifyingPhase: String,
  val verifyingTotalBytes: Long
)

private data class ChunkAcknowledgement(
  val revision: Long,
  val transferReceivedBytes: Long
)

private data class ChunkDigestPage(
  val digests: List<V3ChunkDigest>,
  val total: Int
)

private data class ConfirmedChunkDigest(
  val itemId: String,
  val digest: V3ChunkDigest
)

private data class ChunkIdentity(
  val itemId: String,
  val index: Int
)

private data class Capabilities(
  val maxChunkBytes: Int,
  val maxInFlightChunks: Int,
  val protocols: Set<Int>
)

private data class ControlResponse(val revision: Long, val status: String)

private fun ControlResponse.toMap(): Map<String, Any> = mapOf(
  "revision" to revision,
  "status" to status
)

private data class CommandTicket(
  val id: Long,
  val previousErrorDetails: Map<String, Any>?,
  val previousErrorCode: String?,
  val previousStatus: String
)

private data class QueuedControl(
  val predecessor: CompletableDeferred<Unit>,
  val result: CompletableDeferred<ControlResponse>,
  val tail: CompletableDeferred<Unit>,
  val ticket: CommandTicket
)

private data class StoppedRun(
  val activeCalls: List<Call>,
  val job: Job?,
  val repairJob: Job?
)

private data class PreparedControl(
  val queued: QueuedControl,
  val stoppedRun: StoppedRun
)

private data class PreparedBackgroundPause(
  val queued: QueuedControl,
  val stoppedRun: StoppedRun
)

private data class HttpResponseData(val statusCode: Int, val body: String)

private class AcknowledgementWatch(
  val expectedRunGeneration: Long,
  val startedAtMs: Long,
  val thresholdMs: Long
) {
  val delayed = AtomicBoolean(false)
  val finished = AtomicBoolean(false)
  var watchdog: Job? = null
}

private fun completedCommandTail(): CompletableDeferred<Unit> = CompletableDeferred<Unit>().also { it.complete(Unit) }

private class TransferRequestException(
  val code: String,
  cause: Throwable? = null,
  val details: Map<String, Any>? = null
) : IOException(code, cause)

internal fun chunkDigestMismatchDetails(
  itemId: String,
  local: V3ChunkDigest,
  agent: V3ChunkDigest
): Map<String, Any>? {
  if (local.length == agent.length && local.sha256.contentEquals(agent.sha256)) return null
  return mapOf(
    "agentLength" to agent.length,
    "agentSha256" to agent.sha256.toV3LowerHex(),
    "index" to agent.index,
    "itemId" to itemId,
    "localLength" to local.length,
    "localSha256" to local.sha256.toV3LowerHex()
  )
}

private class ByteArrayRequestBody(
  private val bytes: ByteArray,
  private val mediaType: MediaType?
) : RequestBody() {
  override fun contentLength(): Long = bytes.size.toLong()

  override fun contentType(): MediaType? = mediaType

  override fun writeTo(sink: BufferedSink) {
    sink.write(bytes)
  }
}

/**
 * A private staged source that opens its file independently for hashing and
 * for each OkHttp request. This keeps retries repeatable without retaining a
 * chunk-sized byte array in the React Native runtime or the native heap.
 */
private class ContentChunkSource(
  private val stagingFile: File,
  private val expectedSizeBytes: Long
) {
  fun verifyReadable() {
    withChannel { channel ->
      if (expectedSizeBytes > 0) channel.position(0)
    }
  }

  fun sha256(offset: Long, length: Int): ByteArray = withChannel { channel ->
    position(channel, offset)
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(minOf(length, STREAM_BUFFER_BYTES))
    var remaining = length
    while (remaining > 0) {
      val requested = minOf(remaining, buffer.size)
      val read = channel.read(ByteBuffer.wrap(buffer, 0, requested))
      if (read <= 0) throw TransferRequestException("PART_READ_ERROR")
      digest.update(buffer, 0, read)
      remaining -= read
    }
    digest.digest()
  }

  fun requestBody(offset: Long, length: Int): RequestBody = StreamingChunkRequestBody(this, offset, length)

  fun writeChunk(offset: Long, length: Int, sink: BufferedSink) {
    withChannel { channel ->
      position(channel, offset)
      val buffer = ByteArray(minOf(length, STREAM_BUFFER_BYTES))
      var remaining = length
      while (remaining > 0) {
        val requested = minOf(remaining, buffer.size)
        val read = channel.read(ByteBuffer.wrap(buffer, 0, requested))
        if (read <= 0) throw TransferRequestException("PART_READ_ERROR")
        sink.write(buffer, 0, read)
        remaining -= read
      }
    }
  }

  private fun position(channel: FileChannel, offset: Long) {
    try {
      channel.position(offset)
    } catch (error: IOException) {
      throw TransferRequestException("PART_READ_ERROR", error)
    }
  }

  private fun <T> withChannel(block: (FileChannel) -> T): T {
    if (!stagingFile.isFile || stagingFile.length() != expectedSizeBytes) {
      throw TransferRequestException("PART_READ_ERROR")
    }
    try {
      return FileInputStream(stagingFile).channel.use(block)
    } catch (error: TransferRequestException) {
      throw error
    } catch (error: IOException) {
      throw TransferRequestException("PART_READ_ERROR", error)
    }
  }
}

private class StreamingChunkRequestBody(
  private val source: ContentChunkSource,
  private val offset: Long,
  private val length: Int
) : RequestBody() {
  override fun contentLength(): Long = length.toLong()

  override fun contentType(): MediaType = "application/octet-stream".toMediaType()

  override fun writeTo(sink: BufferedSink) {
    source.writeChunk(offset, length, sink)
  }
}

private class ShrinkableSemaphore(initialPermits: Int) : Semaphore(initialPermits) {
  fun removePermit() {
    reducePermits(1)
  }
}

/**
 * Starts conservatively, grows only after durable ACKs, and shrinks without
 * blocking the caller. Java's semaphore permits may go negative after a
 * reduction while requests are in flight; subsequent releases then drain the
 * excess before another request can enter.
 */
internal class AdaptiveChunkWindow(
  maxPermits: Int,
  initialMemoryCeiling: Int = maxPermits
) {
  private val maximum = maxPermits.coerceAtLeast(1)
  private val initialCeiling = initialMemoryCeiling.coerceIn(1, maximum)
  private val initialPermits = minOf(2, initialCeiling)
  private val semaphore = ShrinkableSemaphore(initialPermits)
  private val lock = Any()
  private var acknowledgementsSinceAdjustment = 0
  private var memoryCeiling = initialCeiling
  private var permits = initialPermits

  suspend fun acquire() {
    while (true) {
      coroutineContext.ensureActive()
      if (semaphore.tryAcquire()) return
      delay(WINDOW_WAIT_MS)
    }
  }

  fun release() {
    semaphore.release()
  }

  fun onDurableAcknowledgement() {
    synchronized(lock) {
      acknowledgementsSinceAdjustment += 1
      if (acknowledgementsSinceAdjustment >= WINDOW_GROWTH_ACKS && permits < memoryCeiling) {
        acknowledgementsSinceAdjustment = 0
        permits += 1
        semaphore.release()
      }
    }
  }

  fun shrinkForRetry() {
    synchronized(lock) {
      acknowledgementsSinceAdjustment = 0
      shrinkToLocked(permits - 1)
    }
  }

  fun shrinkForMemoryPressure() {
    synchronized(lock) {
      memoryCeiling = 1
      acknowledgementsSinceAdjustment = 0
      shrinkToLocked(memoryCeiling)
    }
  }

  private fun shrinkToLocked(target: Int) {
    while (permits > target.coerceAtLeast(1)) {
      permits -= 1
      semaphore.removePermit()
    }
  }
}

private class TransferRecord(
  val config: NativeTransferConfig,
  val operationId: String
) {
  val activeCalls = mutableSetOf<Call>()
  val activeChunkWindows = mutableSetOf<AdaptiveChunkWindow>()
  val chunkDigests = mutableMapOf<String, MutableMap<Int, V3ChunkDigest>>()
  val chunkDigestRevisions = mutableMapOf<String, MutableMap<Int, Long>>()
  val persistedChunkDigests: Map<String, Map<Int, V3ChunkDigest>> = config.persistedChunkDigests
    .groupBy { it.itemId }
    .mapValues { (_, digests) ->
      digests.associate { digest ->
        digest.index to V3ChunkDigest(digest.index, digest.length, digest.sha256)
      }
    }
  val lock = Any()
  val stagingMutex = Mutex()
  val statusRepairMutex = Mutex()
  var activeChunkRequests = 0
  var cancellationReconciliationJob: Job? = null
  var cancellationReconciliationPending = false
  var commandTail = completedCommandTail()
  var completionReconciliationRestarts = 0
  var confirmedBytes = 0L
  var confirmedRateBytesPerSecond = 0L
  var commandGeneration = 0L
  var delayedChunkRequests = 0
  var errorCode: String? = null
  var errorDetails: Map<String, Any>? = null
  var pendingControlCommandId: Long? = null
  var lastAcknowledgementAtMs = 0L
  var lastProgressBytes = 0L
  var lastProgressSubmittedBytes = 0L
  var lastProgressEventAtMs = 0L
  var lastRemoteSnapshot: RemoteTransferSnapshot? = null
  var lastRoundTripTimeMs = INITIAL_RTT_MS
  var lastStatusRepairAtMs = 0L
  var repairJob: Job? = null
  var repairMode = false
  var repairReason: String? = null
  var repairTargetRevision = -1L
  var revision = -1L
  var recoveryManifestEntries = 0
  var recoveryManifestTotal = 0
  var requestsBlocked = false
  var retired = false
  var runGeneration = 0L
  var status = "negotiating"
  val submittedChunks = mutableSetOf<ChunkIdentity>()
  var submittedBytes = 0L
  var transferJob: Job? = null
  var verifyingBytes = 0L
  var verifyingPhase = "idle"
  var verifyingTotalBytes = 0L
}

/**
 * Process-wide V3 uploader. Its application-owned coroutine scope keeps native
 * file and network work outside the JS event loop. A new controller start with
 * the same transfer config asks the Agent for durable ranges before sending
 * chunks, so persisted task rehydration can resume after process recreation.
 */
class TransferController(private val context: Context) : ComponentCallbacks2, Application.ActivityLifecycleCallbacks {
  private val client = OkHttpClient.Builder()
    .connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .writeTimeout(30, TimeUnit.SECONDS)
    .build()
  // A repair must not wait behind the uploader's 30-second read timeout. The
  // request is independent and is itself rate-limited per transfer below.
  private val repairClient = client.newBuilder()
    .callTimeout(STATUS_REPAIR_CALL_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    .connectTimeout(STATUS_REPAIR_CALL_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    .readTimeout(STATUS_REPAIR_CALL_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    .writeTimeout(STATUS_REPAIR_CALL_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    .build()
  private val records = ConcurrentHashMap<String, TransferRecord>()
  private val activeTransferSlots = Semaphore(MAX_ACTIVE_NATIVE_TRANSFERS, true)
  private val stagingLock = Any()
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val connectivityManager = context.applicationContext
    .getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
  private val networkCallback = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) = onNetworkChanged()

    override fun onLost(network: Network) = onNetworkChanged()
  }

  private val backgroundLock = Any()
  private var backgroundEpoch = 0L
  private var startedActivityCount = 0
  private val memoryPressureLock = Any()
  private var memoryPressureCeiling = MAX_NATIVE_IN_FLIGHT_CHUNKS

  @Volatile
  private var uploadsPausedForBackground = false

  @Volatile
  private var eventSink: ((String, Map<String, Any>) -> Unit)? = null

  init {
    context.applicationContext.registerComponentCallbacks(this)
    (context.applicationContext as? Application)?.registerActivityLifecycleCallbacks(this)
    try {
      connectivityManager?.registerNetworkCallback(NetworkRequest.Builder().build(), networkCallback)
    } catch (_: SecurityException) {
      // ACCESS_NETWORK_STATE is declared by this module, but do not make a
      // missing/stripped permission fatal to transfer startup.
    } catch (_: IllegalArgumentException) {
      // Some device builds reject a callback while their connectivity service
      // is shutting down. ACK/watchdog repair remains active.
    }
  }

  fun setEventSink(sink: ((String, Map<String, Any>) -> Unit)?) {
    eventSink = sink
  }

  fun start(config: NativeTransferConfig): String {
    return replaceTransfer(config, requireExisting = false)
  }

  /**
   * ACTION_OPEN_DOCUMENT grants are otherwise process-scoped. Retain only the
   * metadata URI permission here; byte staging remains in the I/O coroutine.
   */
  fun retainSourceUriPermissions(sourceUris: List<String>) {
    sourceUris.forEach { rawUri ->
      val uri = Uri.parse(rawUri)
      when {
        uri.scheme.equals("content", ignoreCase = true) -> {
          try {
            context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
          } catch (error: SecurityException) {
            throw IllegalArgumentException("FILE_ACCESS_NOT_PERSISTABLE", error)
          }
        }
        uri.scheme.equals("file", ignoreCase = true) -> Unit
        else -> throw IllegalArgumentException("FILE_ACCESS_NOT_PERSISTABLE")
      }
    }
  }

  /**
   * Replaces a surviving native record with fresh durable digest metadata from
   * SQLite. The new record enters the normal recovering scan before any chunk
   * can upload, so an Activity/React recreation cannot trust stale cache data.
   */
  fun restartForRecovery(config: NativeTransferConfig): String {
    require(config.recovering) { "Recovery restart requires recovering=true." }
    return replaceTransfer(config, requireExisting = true)
  }

  /**
   * A cancel that survived only in the JS projection must not call create.
   * Query the Agent first; an existing task is cancelled, while a 404 proves
   * there was never a remote transfer to recreate.
   */
  suspend fun reconcileCancelledTransfer(config: NativeTransferConfig): Map<String, Any> {
    // This replaces any survived controller record before the reconciliation
    // request. It stops old calls and ensures new GET/cancel requests use the
    // persisted address and credential, including after key rotation. Do this
    // on every retry: a prior local cancelled snapshot may only mean that a
    // network request failed before the Agent observed the cancellation.
    val record = replaceWithCancelledRecord(config)
    return try {
      reconcileCancelledRecord(record)
    } catch (error: Throwable) {
      val failure = toTransferRequestException(error)
      if (failure.code == "TRANSFER_ENDPOINT_UNAVAILABLE") {
        scheduleCancelledReconciliation(record)
      }
      throw failure
    }
  }

  private fun replaceWithCancelledRecord(config: NativeTransferConfig): TransferRecord {
    val record = TransferRecord(config, UUID.randomUUID().toString())
    synchronized(record.lock) {
      record.revision = config.initialRevision
      record.status = "cancelled"
      record.errorCode = null
      record.errorDetails = null
      record.cancellationReconciliationPending = true
    }
    val previous = synchronized(stagingLock) { records.put(config.transferId, record) }
    previous?.let(::retireRecord)
    return record
  }

  /**
   * Replays only the cancellation intent against the Agent. It never creates
   * a transfer and remains usable after the original bridge call failed while
   * the device was offline.
   */
  private suspend fun reconcileCancelledRecord(record: TransferRecord): Map<String, Any> {
    requireActiveRecord(record)
    val remote = try {
      getStatus(record, allowWhenRequestsBlocked = true)
    } catch (error: Throwable) {
      val failure = toTransferRequestException(error)
      if (failure.code != "TRANSFER_NOT_FOUND") throw failure
      settleMissingCancelledTransfer(record)
      return synchronized(record.lock) { snapshotMap(record, optimistic = false) }
    }

    validateSnapshot(record, remote)
    applyTransientRemoteSnapshot(record, remote)
    if (isTerminal(remote.status)) {
      cleanupTerminalStagingNow(record)
      requireActiveRecord(record)
      if (!applyRemoteSnapshot(record, remote)) throw TransferRequestException("TRANSFER_SUPERSEDED")
      markCancelledReconciliationSettled(record)
      return synchronized(record.lock) { snapshotMap(record, optimistic = false) }
    }

    val response = postControl(record, "cancel", trackActiveCall = true)
    if (response.status != "cancelled") throw TransferRequestException("TRANSFER_PROTOCOL_ERROR")
    cleanupTerminalStagingNow(record)
    val settled = synchronized(record.lock) {
      if (record.retired || records[record.config.transferId] !== record) return@synchronized false
      record.revision = max(record.revision, response.revision)
      record.status = response.status
      record.errorCode = null
      record.errorDetails = null
      record.cancellationReconciliationPending = false
      true
    }
    if (!settled) throw TransferRequestException("TRANSFER_SUPERSEDED")
    emitState(record)
    emitProgress(record, force = true)
    return synchronized(record.lock) { snapshotMap(record, optimistic = false) }
  }

  private suspend fun settleMissingCancelledTransfer(record: TransferRecord) {
    cleanupTerminalStagingNow(record)
    val settled = synchronized(record.lock) {
      if (record.retired || records[record.config.transferId] !== record) return@synchronized false
      record.status = "cancelled"
      record.errorCode = null
      record.errorDetails = null
      record.cancellationReconciliationPending = false
      true
    }
    if (!settled) throw TransferRequestException("TRANSFER_SUPERSEDED")
    emitState(record)
    emitProgress(record, force = true)
  }

  private fun markCancelledReconciliationSettled(record: TransferRecord) {
    synchronized(record.lock) {
      if (!record.retired && records[record.config.transferId] === record) {
        record.cancellationReconciliationPending = false
      }
    }
  }

  /** Retries an uncertain cancellation only while the Agent is unavailable. */
  private fun scheduleCancelledReconciliation(record: TransferRecord) {
    lateinit var job: Job
    val shouldStart = synchronized(record.lock) {
      if (
        record.retired
        || !record.cancellationReconciliationPending
        || record.cancellationReconciliationJob?.isActive == true
      ) {
        false
      } else {
        job = scope.launch(start = CoroutineStart.LAZY) {
          var retryAttempt = 0
          try {
            while (isCancellationReconciliationPending(record)) {
              delay(RECOVERY_REPAIR_DELAYS_MS[minOf(retryAttempt, RECOVERY_REPAIR_DELAYS_MS.lastIndex)])
              try {
                reconcileCancelledRecord(record)
                return@launch
              } catch (error: CancellationException) {
                throw error
              } catch (error: Throwable) {
                if (toTransferRequestException(error).code != "TRANSFER_ENDPOINT_UNAVAILABLE") return@launch
                retryAttempt += 1
              }
            }
          } finally {
            synchronized(record.lock) {
              if (record.cancellationReconciliationJob === job) {
                record.cancellationReconciliationJob = null
              }
            }
          }
        }
        record.cancellationReconciliationJob = job
        true
      }
    }
    if (shouldStart) job.start()
  }

  private fun isCancellationReconciliationPending(record: TransferRecord): Boolean {
    return records[record.config.transferId] === record && synchronized(record.lock) {
      !record.retired && record.cancellationReconciliationPending
    }
  }

  private fun replaceTransfer(config: NativeTransferConfig, requireExisting: Boolean): String {
    allowForegroundUploads()
    val record = TransferRecord(config, UUID.randomUUID().toString())
    synchronized(record.lock) {
      record.revision = config.initialRevision
      record.status = if (config.recovering) "recovering" else "transferring"
      record.errorCode = null
      record.errorDetails = null
    }
    val previous = synchronized(stagingLock) {
      val current = records[config.transferId]
      if (requireExisting) {
        if (current == null) throw IllegalArgumentException("TRANSFER_NOT_FOUND")
        require(isCompatibleRecoveryRestart(current.config, config)) { "TRANSFER_RECOVERY_CONFIG_INVALID" }
      }
      records.put(config.transferId, record)
    }
    previous?.let { previous ->
      retireRecord(previous)
    }
    // The initial state is installed before publishing the record. A control
    // that arrives now owns its transition and must not be overwritten here.
    emitState(record, optimistic = true)
    launchRun(record)
    return record.operationId
  }

  private fun isCompatibleRecoveryRestart(
    current: NativeTransferConfig,
    replacement: NativeTransferConfig
  ): Boolean {
    if (current.transferId != replacement.transferId || current.sourceDeviceId != replacement.sourceDeviceId) return false
    if (current.items.size != replacement.items.size) return false
    return current.items.zip(replacement.items).all { (existing, incoming) ->
      existing.itemId == incoming.itemId
        && existing.mimeType == incoming.mimeType
        && existing.name == incoming.name
        && existing.sizeBytes == incoming.sizeBytes
        && existing.sourceUri == incoming.sourceUri
    }
  }

  suspend fun pause(transferId: String): Map<String, Any> {
    val record = records[transferId] ?: throw IllegalArgumentException("TRANSFER_NOT_FOUND")
    val prepared = beginCommand(record, "paused", permitCancelled = false)
    return launchQueuedControl(record, prepared.queued, "pause").await().toMap()
  }

  suspend fun resume(transferId: String): Map<String, Any> {
    val record = records[transferId] ?: throw IllegalArgumentException("TRANSFER_NOT_FOUND")
    allowForegroundUploads()
    val prepared = beginCommand(record, "transferring", permitCancelled = false)
    // Resume is idempotent while the Agent is already transferring. Retire an
    // older local run first so the successful control response always owns the
    // next run generation instead of inheriting a stale uploader.
    return launchQueuedControl(record, prepared.queued, "resume").await().toMap()
  }

  suspend fun cancel(transferId: String): Map<String, Any> {
    val record = records[transferId] ?: throw IllegalArgumentException("TRANSFER_NOT_FOUND")
    val prepared = beginCommand(record, "cancelled", permitCancelled = true)
    return launchQueuedControl(record, prepared.queued, "cancel").await().toMap()
  }

  fun snapshot(transferId: String): Map<String, Any>? {
    val record = records[transferId] ?: return null
    return synchronized(record.lock) { snapshotMap(record, optimistic = false) }
  }

  private fun beginCommand(record: TransferRecord, optimisticStatus: String, permitCancelled: Boolean): PreparedControl {
    val prepared = synchronized(record.lock) {
      requireActiveRecord(record)
      if (isTerminal(record.status) && !(permitCancelled && record.status == "cancelled")) {
        throw IllegalStateException("TRANSFER_STATE_INVALID")
      }
      // This is the request gate. It and the active-call snapshot share the
      // same lock as executeSigned's registration, so pause/cancel cannot miss
      // a call that is concurrently being registered.
      val stoppedRun = stopRunAndBlockLocked(record)
      record.commandGeneration += 1
      val result = CommandTicket(record.commandGeneration, record.errorDetails, record.errorCode, record.status)
      record.pendingControlCommandId = record.commandGeneration
      record.status = optimisticStatus
      record.errorCode = null
      record.errorDetails = null
      val predecessor = record.commandTail
      val tail = CompletableDeferred<Unit>()
      record.commandTail = tail
      PreparedControl(
        queued = QueuedControl(predecessor, CompletableDeferred<ControlResponse>(), tail, result),
        stoppedRun = stoppedRun
      )
    }
    cancelStoppedRun(prepared.stoppedRun)
    emitState(record, optimistic = true)
    return prepared
  }

  private fun launchQueuedControl(
    record: TransferRecord,
    queued: QueuedControl,
    operation: String
  ): CompletableDeferred<ControlResponse> {
    scope.launch {
      try {
        queued.predecessor.await()
        requireActiveRecord(record)
        val response = postControl(record, operation)
        if (operation == "cancel" && response.status == "cancelled") {
          // The Agent has accepted cancellation, but do not publish its final
          // local state until the Android-owned .part tree is actually gone.
          cleanupTerminalStagingNow(record)
        }
        requireActiveRecord(record)
        applyControlResponse(record, response, queued.ticket.id)
        if (operation == "resume" && response.status == "transferring" && isCurrentCommand(record, queued.ticket.id)) {
          launchRunIfIdle(record, expectedCommandGeneration = queued.ticket.id)
        }
        if (isCurrentCommand(record, queued.ticket.id)) {
          scope.launch { refreshAfterControl(record, queued.ticket) }
        }
        queued.result.complete(response)
      } catch (error: Throwable) {
        if (isActiveRecord(record) && isCurrentCommand(record, queued.ticket.id)) {
          recoverAfterControlFailure(record, error, queued.ticket)
        }
        queued.result.completeExceptionally(error)
      } finally {
        queued.tail.complete(Unit)
      }
    }
    return queued.result
  }

  private fun launchRunIfIdle(
    record: TransferRecord,
    expectedRunGeneration: Long? = null,
    expectedCommandGeneration: Long? = null
  ) {
    val job = synchronized(record.lock) {
      if (
        records[record.config.transferId] !== record
        || record.retired
        || uploadsPausedForBackground
        || (expectedRunGeneration != null && record.runGeneration != expectedRunGeneration)
        || (expectedCommandGeneration != null && record.commandGeneration != expectedCommandGeneration)
        || !isRunEligibleStatus(record.status)
        || record.transferJob?.isActive == true
      ) {
        return@synchronized null
      }
      createRunLocked(record)
    }
    job?.start()
  }

  private fun launchRun(record: TransferRecord) {
    val job = synchronized(record.lock) {
      if (
        records[record.config.transferId] !== record
        || record.retired
        || uploadsPausedForBackground
        || !isRunEligibleStatus(record.status)
      ) {
        return@synchronized null
      }
      createRunLocked(record)
    }
    job?.start()
  }

  private fun createRunLocked(record: TransferRecord): Job {
    record.transferJob?.cancel()
    record.requestsBlocked = false
    record.runGeneration += 1
    val generation = record.runGeneration
    val commandGeneration = record.commandGeneration
    return scope.launch(start = CoroutineStart.LAZY) {
      runTransfer(record, generation, commandGeneration)
    }.also { record.transferJob = it }
  }

  private fun stopRun(record: TransferRecord) {
    val stoppedRun = synchronized(record.lock) {
      stopRunAndBlockLocked(record)
    }
    cancelStoppedRun(stoppedRun)
  }

  private fun stopRunLocked(record: TransferRecord): Job? {
    record.runGeneration += 1
    return record.transferJob.also { record.transferJob = null }
  }

  private fun stopRunAndBlockLocked(record: TransferRecord): StoppedRun {
    record.requestsBlocked = true
    val repairJob = record.repairJob
    record.repairJob = null
    record.repairMode = false
    record.repairReason = null
    record.repairTargetRevision = record.revision
    return StoppedRun(record.activeCalls.toList(), stopRunLocked(record), repairJob)
  }

  private fun cancelStoppedRun(stoppedRun: StoppedRun) {
    stoppedRun.job?.cancel()
    stoppedRun.repairJob?.cancel()
    stoppedRun.activeCalls.forEach { call -> call.cancel() }
  }

  private fun retireRecord(record: TransferRecord) {
    val (stoppedRun, cancellationReconciliationJob) = synchronized(record.lock) {
      record.retired = true
      val stoppedRun = stopRunAndBlockLocked(record)
      val reconciliationJob = record.cancellationReconciliationJob
      record.cancellationReconciliationJob = null
      Pair(stoppedRun, reconciliationJob)
    }
    cancelStoppedRun(stoppedRun)
    cancellationReconciliationJob?.cancel()
  }

  /**
   * The picker URI is only an ingress handle. Native copies it into private
   * storage before hashing or uploading so an Activity/React recreation does
   * not depend on a JS-owned cache file or an expiring provider URI.
   */
  private suspend fun stagedChunkSource(record: TransferRecord, item: NativeTransferItem): ContentChunkSource {
    return record.stagingMutex.withLock {
      val stagingFile = privateStagingFile(record, item)
      if (stagingFile.isFile && stagingFile.length() == item.sizeBytes) {
        return@withLock ContentChunkSource(stagingFile, item.sizeBytes)
      }
      ContentChunkSource(stageSourceUri(record, item, stagingFile), item.sizeBytes)
    }
  }

  private suspend fun stageSourceUri(
    record: TransferRecord,
    item: NativeTransferItem,
    stagingFile: File
  ): File = withContext(Dispatchers.IO) {
    val directory = privateStagingDirectory(record)
    if (!directory.exists() && !directory.mkdirs()) {
      throw TransferRequestException("PART_READ_ERROR")
    }
    if (!directory.isDirectory) throw TransferRequestException("PART_READ_ERROR")

    val temporaryFile = File(directory, ".${item.itemId}.${UUID.randomUUID()}.tmp")
    var sourceOpened = false
    try {
      val input = try {
        context.contentResolver.openInputStream(Uri.parse(item.sourceUri))
      } catch (error: IOException) {
        throw TransferRequestException("FILE_CHANGED", error)
      } catch (error: SecurityException) {
        throw TransferRequestException("FILE_CHANGED", error)
      } ?: throw TransferRequestException("FILE_CHANGED")
      sourceOpened = true

      var copiedBytes = 0L
      input.use { source ->
        try {
          FileOutputStream(temporaryFile).use { target ->
            val buffer = ByteArray(STREAM_BUFFER_BYTES)
            while (true) {
              coroutineContext.ensureActive()
              val read = source.read(buffer)
              if (read < 0) break
              if (read == 0) continue
              target.write(buffer, 0, read)
              copiedBytes += read
              if (copiedBytes > item.sizeBytes) throw TransferRequestException("FILE_CHANGED")
            }
            target.fd.sync()
          }
        } catch (error: TransferRequestException) {
          throw error
        } catch (error: IOException) {
          throw TransferRequestException("PART_READ_ERROR", error)
        }
      }
      if (copiedBytes != item.sizeBytes) throw TransferRequestException("FILE_CHANGED")
      coroutineContext.ensureActive()
      if (stagingFile.exists() && !stagingFile.delete()) throw TransferRequestException("PART_READ_ERROR")
      if (!temporaryFile.renameTo(stagingFile)) throw TransferRequestException("PART_READ_ERROR")
      stagingFile
    } catch (error: TransferRequestException) {
      throw error
    } catch (error: IOException) {
      // An input-stream failure after opening the document means the selected
      // document changed or its provider stopped serving it.
      throw TransferRequestException(if (sourceOpened) "FILE_CHANGED" else "PART_READ_ERROR", error)
    } finally {
      if (temporaryFile.exists()) temporaryFile.delete()
    }
  }

  private fun privateStagingDirectory(record: TransferRecord): File {
    return File(File(context.filesDir, "flowdrop-v3-outgoing"), record.config.transferId)
  }

  private fun privateStagingFile(record: TransferRecord, item: NativeTransferItem): File {
    return File(privateStagingDirectory(record), "${item.itemId}.part")
  }

  private fun cleanupTerminalStaging(record: TransferRecord, errorCode: String?) {
    scope.launch {
      try {
        cleanupTerminalStagingNow(record)
      } catch (_: TransferRequestException) {
        // Explicit cancel paths await deletion and surface this failure. Other
        // terminal cleanup is best-effort because its Agent result is already
        // durable and must not be rewritten as a transfer failure.
      }
    }
  }

  /** Waits for staging I/O to stop and proves that the private tree is gone. */
  private suspend fun cleanupTerminalStagingNow(record: TransferRecord) {
    val deleted = record.stagingMutex.withLock {
      withContext(Dispatchers.IO) {
        synchronized(stagingLock) {
          if (records[record.config.transferId] !== record) return@synchronized true
          deletePrivateStaging(privateStagingDirectory(record))
        }
      }
    }
    if (!deleted) throw TransferRequestException("PART_READ_ERROR")
  }

  private fun deletePrivateStaging(path: File): Boolean {
    if (!path.exists()) return true
    if (path.isDirectory) {
      val children = path.listFiles() ?: return false
      if (children.any { child -> !deletePrivateStaging(child) }) return false
    }
    return !path.exists() || path.delete()
  }

  private fun isActiveRecord(record: TransferRecord): Boolean {
    return records[record.config.transferId] === record && synchronized(record.lock) { !record.retired }
  }

  private fun requireActiveRecord(record: TransferRecord) {
    if (!isActiveRecord(record)) throw TransferRequestException("TRANSFER_SUPERSEDED")
  }

  private suspend fun runTransfer(
    record: TransferRecord,
    runGeneration: Long,
    commandGeneration: Long
  ) {
    var ownsTransferSlot = false
    try {
      acquireTransferSlot()
      ownsTransferSlot = true
      ensureCurrentRun(record, runGeneration)
      val capabilities = getCapabilities(record)
      ensureCurrentRun(record, runGeneration)
      if (!capabilities.protocols.contains(V3TransferProtocol.PROTOCOL)) {
        throw TransferRequestException("V3_CAPABILITY_UNAVAILABLE")
      }
      val requestedChunkSize = minOf(record.config.initialChunkSizeBytes, capabilities.maxChunkBytes)
      if (requestedChunkSize !in V3TransferProtocol.MIN_CHUNK_BYTES..V3TransferProtocol.MAX_CHUNK_BYTES) {
        throw TransferRequestException("V3_CAPABILITY_UNAVAILABLE")
      }

      val create = createTransfer(record, requestedChunkSize)
      ensureCurrentRun(record, runGeneration)
      validateSnapshot(record, create)
      applyRemoteSnapshot(record, create, expectedRunGeneration = runGeneration)
      val chunkSizeBytes = create.chunkSizeBytes
        ?: throw TransferRequestException("TRANSFER_PROTOCOL_ERROR")
      if (chunkSizeBytes !in V3TransferProtocol.MIN_CHUNK_BYTES..minOf(capabilities.maxChunkBytes, V3TransferProtocol.MAX_CHUNK_BYTES)) {
        throw TransferRequestException("TRANSFER_PROTOCOL_ERROR")
      }

      when (create.status) {
        "completed", "paused", "cancelled", "failed" -> return
        "completing" -> {
          waitForCompletion(record, runGeneration)
          return
        }
        "negotiating", "transferring" -> Unit
        else -> return
      }

      val maxInFlightChunks = minOf(MAX_NATIVE_IN_FLIGHT_CHUNKS, max(1, capabilities.maxInFlightChunks))
      var transferSnapshot = create
      // A waiting_for_peer task can be resumed in the same process, so cold
      // start is not the only recovery path. Any durable Agent range (or local
      // persisted metadata) must be reconciled before we decide which chunks to
      // send. This is what turns a restarted/resumed task into a digest check
      // rather than a blind re-upload.
      val needsDigestReconciliation = record.config.recovering
        || transferSnapshot.receivedRanges.values.any { it.isNotEmpty() }
        || record.config.persistedChunkDigests.isNotEmpty()
        || hasCachedChunkDigests(record)
      if (needsDigestReconciliation) {
        updateStatus(record, "recovering")
        transferSnapshot = restoreRemoteDigests(record, runGeneration, chunkSizeBytes, create)
        ensureCurrentRun(record, runGeneration)
        when (transferSnapshot.status) {
          "completed", "paused", "cancelled", "failed" -> return
          "completing" -> {
            waitForCompletion(record, runGeneration)
            return
          }
          "negotiating", "transferring" -> Unit
          else -> return
        }
        updateStatus(record, "transferring")
      }
      val roots = record.config.items.map { item ->
        transferItem(record, runGeneration, item, chunkSizeBytes, maxInFlightChunks, transferSnapshot.receivedRanges[item.itemId].orEmpty())
      }
      ensureCurrentRun(record, runGeneration)
      val completion = completeTransfer(record, runGeneration, roots)
      ensureCurrentRun(record, runGeneration)
      validateSnapshot(record, completion)
      applyRemoteSnapshot(record, completion, expectedRunGeneration = runGeneration)
      if (completion.status == "completing") waitForCompletion(record, runGeneration)
    } catch (_: CancellationException) {
      // pause/cancel invalidate the run generation before cancelling its requests.
    } catch (error: Throwable) {
      handleRunFailure(record, runGeneration, commandGeneration, error)
    } finally {
      if (ownsTransferSlot) activeTransferSlots.release()
      synchronized(record.lock) {
        if (record.runGeneration == runGeneration) record.transferJob = null
      }
    }
  }

  private suspend fun acquireTransferSlot() {
    while (true) {
      coroutineContext.ensureActive()
      if (activeTransferSlots.tryAcquire()) return
      delay(WINDOW_WAIT_MS)
    }
  }

  private suspend fun transferItem(
    record: TransferRecord,
    runGeneration: Long,
    item: NativeTransferItem,
    chunkSizeBytes: Int,
    maxInFlightChunks: Int,
    initiallyReceived: List<IntRange>
  ): V3CompletionFile = coroutineScope {
    val window = AdaptiveChunkWindow(maxInFlightChunks, currentMemoryPressureCeiling(maxInFlightChunks))
    synchronized(record.lock) { record.activeChunkWindows += window }
    try {
      val source = stagedChunkSource(record, item)
      source.verifyReadable()
      val jobs = mutableListOf<Deferred<Unit>>()
      val count = V3TransferProtocol.chunkCount(item.sizeBytes, chunkSizeBytes)
      val digests = ArrayList<V3ChunkDigest>(count)

      for (chunkIndex in 0 until count) {
        ensureCurrentRun(record, runGeneration)
        val length = V3TransferProtocol.expectedChunkLength(item.sizeBytes, chunkSizeBytes, chunkIndex)
        val offset = chunkIndex.toLong() * chunkSizeBytes
        if (isReceived(initiallyReceived, chunkIndex)) {
          val digest = cachedChunkDigest(record, item.itemId, chunkIndex, length)
            ?: V3ChunkDigest(chunkIndex, length, source.sha256(offset, length))
          digests += digest
          continue
        }

        window.acquire()
        try {
          ensureCurrentRun(record, runGeneration)
          val digest = source.sha256(offset, length)
          val chunkDigest = V3ChunkDigest(chunkIndex, length, digest)
          digests += chunkDigest
          addSubmitted(record, item.itemId, chunkIndex, length.toLong())
          jobs += async {
            try {
              val acknowledgement = uploadChunk(record, runGeneration, item, chunkIndex, offset, length, source, digest, window)
              ensureCurrentRun(record, runGeneration)
              window.onDurableAcknowledgement()
              applyChunkAcknowledgement(record, acknowledgement, runGeneration)
              recordDurableChunkDigest(record, item.itemId, chunkDigest, acknowledgement, runGeneration)
            } finally {
              window.release()
            }
          }
        } catch (error: Throwable) {
          window.release()
          throw error
        }
      }
      jobs.awaitAll()
      ensureCurrentRun(record, runGeneration)
      V3CompletionFile(
        contentRoot = V3TransferProtocol.contentRoot(item.sizeBytes, chunkSizeBytes, digests),
        itemId = item.itemId
      )
    } finally {
      synchronized(record.lock) { record.activeChunkWindows.remove(window) }
    }
  }

  private suspend fun restoreRemoteDigests(
    record: TransferRecord,
    runGeneration: Long,
    chunkSizeBytes: Int,
    initialSnapshot: RemoteTransferSnapshot
  ): RemoteTransferSnapshot {
    val totalChunks = record.config.items.sumOf { item ->
      V3TransferProtocol.chunkCount(item.sizeBytes, chunkSizeBytes)
    }
    var snapshot = initialSnapshot
    var repairAttempt = 0
    while (true) {
      updateRecoveryManifest(record, 0, totalChunks, force = true)
      val scanCompleted = try {
        scanRemoteDigests(record, runGeneration, chunkSizeBytes, snapshot.receivedRanges, totalChunks)
      } catch (error: CancellationException) {
        throw error
      } catch (error: Throwable) {
        val failure = toTransferRequestException(error)
        if (failure.code != "TRANSFER_ENDPOINT_UNAVAILABLE") throw failure
        false
      }
      if (scanCompleted) {
        return snapshot
      }

      // Chunk-digest pages are not a revisioned snapshot. A request that was
      // authorised before app restart can become durable while pages are read.
      // Refresh V3 status and restart from its newer ranges rather than fail.
      val refreshed = try {
        getStatus(record)
      } catch (error: CancellationException) {
        throw error
      } catch (error: Throwable) {
        val failure = toTransferRequestException(error)
        if (failure.code != "TRANSFER_ENDPOINT_UNAVAILABLE") throw failure
        delay(RECOVERY_REPAIR_DELAYS_MS[minOf(repairAttempt, RECOVERY_REPAIR_DELAYS_MS.lastIndex)])
        repairAttempt += 1
        continue
      }
      ensureCurrentRun(record, runGeneration)
      validateSnapshot(record, refreshed)
      applyRemoteSnapshot(record, refreshed, expectedRunGeneration = runGeneration)
      snapshot = refreshed
      if (snapshot.status !in setOf("negotiating", "transferring")) return snapshot
      delay(RECOVERY_REPAIR_DELAYS_MS[minOf(repairAttempt, RECOVERY_REPAIR_DELAYS_MS.lastIndex)])
      repairAttempt += 1
    }
  }

  private suspend fun scanRemoteDigests(
    record: TransferRecord,
    runGeneration: Long,
    chunkSizeBytes: Int,
    receivedRanges: Map<String, List<IntRange>>,
    totalChunks: Int
  ): Boolean {
    var restoredEntries = 0
    for (item in record.config.items) {
      ensureCurrentRun(record, runGeneration)
      val chunkCount = V3TransferProtocol.chunkCount(item.sizeBytes, chunkSizeBytes)
      val expectedIndexes = receivedIndexes(receivedRanges[item.itemId].orEmpty(), chunkCount)
      if (expectedIndexes.isEmpty()) continue

      val receivedDigests = mutableMapOf<Int, V3ChunkDigest>()
      var offset = 0
      var pageTotal: Int? = null
      var previousDigestIndex = -1
      while (true) {
        ensureCurrentRun(record, runGeneration)
        val page = getChunkDigestPage(record, item.itemId, offset, 1000)
        if (pageTotal == null) pageTotal = page.total
        if (page.total != pageTotal || page.digests.isEmpty()) return false
        val confirmedPageDigests = ArrayList<ConfirmedChunkDigest>(page.digests.size)
        for (digest in page.digests) {
          if (digest.index !in 0 until chunkCount
            || digest.index <= previousDigestIndex
            || digest.length != V3TransferProtocol.expectedChunkLength(item.sizeBytes, chunkSizeBytes, digest.index)
            || receivedDigests.put(digest.index, digest) != null) {
            throw TransferRequestException("TRANSFER_PROTOCOL_ERROR")
          }
          previousDigestIndex = digest.index
          cacheAgentConfirmedChunkDigest(record, item.itemId, digest)
          confirmedPageDigests += ConfirmedChunkDigest(item.itemId, digest)
          restoredEntries += 1
          updateRecoveryManifest(record, restoredEntries, totalChunks)
        }
        emitConfirmedDigests(record, confirmedPageDigests)
        offset += page.digests.size
        if (offset >= page.total) break
      }

      if (!receivedDigests.keys.containsAll(expectedIndexes)) return false
    }
    updateRecoveryManifest(record, restoredEntries, totalChunks, force = true)
    return true
  }

  private suspend fun getChunkDigestPage(
    record: TransferRecord,
    itemId: String,
    offset: Int,
    limit: Int
  ): ChunkDigestPage {
    val path = V3TransferProtocol.chunkDigestPagePath(record.config.transferId, itemId, offset, limit)
    val response = executeByteRequest(record, "GET", path, ByteArray(0), emptyMap(), trackCall = true)
    requireSuccess(response, setOf(200))
    try {
      val body = JSONObject(response.body)
      val total = body.getInt("total")
      if (total < 0) throw TransferRequestException("TRANSFER_PROTOCOL_ERROR")
      val values = body.getJSONArray("digests")
      if (values.length() > limit || values.length() > total - offset) {
        throw TransferRequestException("TRANSFER_PROTOCOL_ERROR")
      }
      val digests = buildList {
        for (index in 0 until values.length()) {
          val value = values.getJSONObject(index)
          val digestIndex = value.getInt("index")
          val length = value.getInt("length")
          val sha256 = value.getString("sha256")
          if (digestIndex < 0 || length <= 0 || !sha256.matches(Regex("^[a-f0-9]{64}$"))) {
            throw TransferRequestException("TRANSFER_PROTOCOL_ERROR")
          }
          add(V3ChunkDigest(digestIndex, length, V3TransferProtocol.decodeHex(sha256)))
        }
      }
      return ChunkDigestPage(digests, total)
    } catch (error: TransferRequestException) {
      throw error
    } catch (error: Throwable) {
      throw TransferRequestException("TRANSFER_PROTOCOL_ERROR", error)
    }
  }

  private suspend fun getCapabilities(record: TransferRecord): Capabilities {
    val response = executeByteRequest(record, "GET", "/v1/transport/capabilities", ByteArray(0), emptyMap(), trackCall = true)
    requireSuccess(response, setOf(200))
    try {
      val body = JSONObject(response.body)
      val maxChunkBytes = body.getInt("maxChunkBytes")
      val maxInFlightChunks = body.getInt("maxInFlightChunks")
      if (maxChunkBytes !in V3TransferProtocol.MIN_CHUNK_BYTES..V3TransferProtocol.MAX_CHUNK_BYTES || maxInFlightChunks < 1) {
        throw TransferRequestException("V3_CAPABILITY_UNAVAILABLE")
      }
      return Capabilities(maxChunkBytes, maxInFlightChunks, body.getJSONArray("protocols").toIntSet())
    } catch (error: TransferRequestException) {
      throw error
    } catch (error: Throwable) {
      throw TransferRequestException("TRANSFER_PROTOCOL_ERROR", error)
    }
  }

  private suspend fun createTransfer(record: TransferRecord, chunkSizeBytes: Int): RemoteTransferSnapshot {
    val body = V3TransferProtocol.canonicalCreateBody(
      record.config.transferId,
      record.config.sourceDeviceId,
      chunkSizeBytes,
      record.config.items.map { V3CreateItem(it.itemId, it.mimeType, it.name, it.sizeBytes) }
    )
    val response = executeByteRequest(
      record,
      "POST",
      "/v3/transfers",
      body,
      mapOf("Content-Type" to "application/json"),
      trackCall = true
    )
    requireSuccess(response, setOf(200, 201))
    return parseRemoteSnapshot(response.body, requiresChunkSize = true)
  }

  private suspend fun uploadChunk(
    record: TransferRecord,
    runGeneration: Long,
    item: NativeTransferItem,
    chunkIndex: Int,
    offset: Long,
    length: Int,
    source: ContentChunkSource,
    digest: ByteArray,
    window: AdaptiveChunkWindow
  ): ChunkAcknowledgement {
    val path = "/v3/transfers/${record.config.transferId}/items/${item.itemId}/chunks/$chunkIndex"
    val digestHex = digest.toV3LowerHex()
    val headers = mapOf(
      "Content-Range" to "bytes $offset-${offset + length - 1}/${item.sizeBytes}",
      "Content-Type" to "application/octet-stream",
      "X-FlowDrop-Chunk-Sha256" to digestHex
    )
    val acknowledgementWatch = beginAcknowledgementWatch(record, runGeneration)
    var durableAcknowledgement = false
    var lastError: Throwable? = null
    try {
      repeat(MAX_CHUNK_RETRIES) { attempt ->
        coroutineContext.ensureActive()
        try {
          val response = executeSigned(
            record,
            "PUT",
            path,
            source.requestBody(offset, length),
            digestHex,
            headers,
            trackCall = true
          )
          if (response.statusCode == 200) {
            val body = JSONObject(response.body)
            durableAcknowledgement = true
            return ChunkAcknowledgement(body.getLong("revision"), body.getLong("transferReceivedBytes"))
          }
          val errorCode = response.errorCode()
          if (errorCode == "TRANSFER_PAUSED") throw TransferRequestException("TRANSFER_PAUSED")
          if (errorCode == "CHUNK_HASH_MISMATCH") throw TransferRequestException("FILE_CHANGED")
          if (errorCode == "TRANSFER_CLOSING") {
            val repaired = repairStatus(record, runGeneration)
            if (isReceived(repaired.receivedRanges[item.itemId].orEmpty(), chunkIndex)) {
              durableAcknowledgement = true
              return ChunkAcknowledgement(repaired.revision, repaired.transferReceivedBytes)
            }
          }
          if (response.statusCode !in 500..599) throw TransferRequestException(errorCode ?: "TRANSFER_PROTOCOL_ERROR")
          scheduleStatusRepair(record, runGeneration, "HTTP_5XX")
          lastError = TransferRequestException("TRANSFER_ENDPOINT_UNAVAILABLE")
        } catch (error: CancellationException) {
          throw error
        } catch (error: Throwable) {
          lastError = error
        }
        val retryFailure = toTransferRequestException(lastError)
        if (retryFailure.code == "TRANSFER_PAUSED") throw retryFailure
        if (attempt + 1 < MAX_CHUNK_RETRIES) {
          window.shrinkForRetry()
          delay(250L * (attempt + 1))
        }
      }
      val failure = toTransferRequestException(lastError)
      if (failure.code == "TRANSFER_ENDPOINT_UNAVAILABLE" || failure.code == "TRANSFER_CLOSING") {
        try {
          val repaired = repairStatus(record, runGeneration)
          if (isReceived(repaired.receivedRanges[item.itemId].orEmpty(), chunkIndex)) {
            durableAcknowledgement = true
            return ChunkAcknowledgement(repaired.revision, repaired.transferReceivedBytes)
          }
        } catch (error: CancellationException) {
          throw error
        } catch (_: Throwable) {
          // The original retry result remains the actionable failure when repair fails.
        }
      }
      throw failure
    } finally {
      finishAcknowledgementWatch(record, acknowledgementWatch, durableAcknowledgement)
    }
  }

  private suspend fun completeTransfer(
    record: TransferRecord,
    runGeneration: Long,
    files: List<V3CompletionFile>
  ): RemoteTransferSnapshot {
    val body = V3TransferProtocol.canonicalCompleteBody(files)
    var lastFailure: TransferRequestException? = null
    var lastStatusReconciliationAtMs = Long.MIN_VALUE

    suspend fun reconcileUncertainCompletion(waitForRateLimit: Boolean): RemoteTransferSnapshot? {
      val now = System.currentTimeMillis()
      val elapsed = now - lastStatusReconciliationAtMs
      if (lastStatusReconciliationAtMs != Long.MIN_VALUE && elapsed < STATUS_REPAIR_MIN_INTERVAL_MS) {
        if (!waitForRateLimit) return null
        delay(STATUS_REPAIR_MIN_INTERVAL_MS - elapsed)
      }
      ensureCurrentRun(record, runGeneration)
      lastStatusReconciliationAtMs = System.currentTimeMillis()
      return completionStatusAfterUncertainRequest(record, runGeneration)
    }

    repeat(MAX_CHUNK_RETRIES) { attempt ->
      coroutineContext.ensureActive()
      val response = try {
        executeByteRequest(
          record,
          "POST",
          "/v3/transfers/${record.config.transferId}/complete",
          body,
          mapOf("Content-Type" to "application/json"),
          trackCall = true
        )
      } catch (error: CancellationException) {
        throw error
      } catch (error: Throwable) {
        reconcileUncertainCompletion(waitForRateLimit = false)?.let { snapshot ->
          if (isCompletionRemoteOutcome(snapshot.status)) return snapshot
        }
        val failure = toTransferRequestException(error)
        if (failure.code != "TRANSFER_ENDPOINT_UNAVAILABLE") throw failure
        lastFailure = failure
        if (attempt + 1 < MAX_CHUNK_RETRIES) delay(250L * (attempt + 1))
        return@repeat
      }

      if (response.statusCode == 200 || response.statusCode == 202) {
        return parseRemoteSnapshot(response.body, requiresChunkSize = false)
      }

      val failure = TransferRequestException(
        if (response.statusCode in 500..599) "TRANSFER_ENDPOINT_UNAVAILABLE" else response.errorCode() ?: "TRANSFER_PROTOCOL_ERROR"
      )
      reconcileUncertainCompletion(waitForRateLimit = false)?.let { snapshot ->
        if (isCompletionRemoteOutcome(snapshot.status)) return snapshot
      }
      if (response.statusCode !in 500..599) throw failure
      lastFailure = failure
      if (attempt + 1 < MAX_CHUNK_RETRIES) delay(250L * (attempt + 1))
    }

    reconcileUncertainCompletion(waitForRateLimit = true)?.let { snapshot ->
      if (isCompletionRemoteOutcome(snapshot.status)) return snapshot
    }
    throw lastFailure ?: TransferRequestException("TRANSFER_ENDPOINT_UNAVAILABLE")
  }

  private suspend fun completionStatusAfterUncertainRequest(
    record: TransferRecord,
    runGeneration: Long
  ): RemoteTransferSnapshot? {
    return try {
      val snapshot = getStatus(record)
      ensureCurrentRun(record, runGeneration)
      validateSnapshot(record, snapshot)
      snapshot.takeIf { applyRemoteSnapshot(record, it, expectedRunGeneration = runGeneration) }
    } catch (error: CancellationException) {
      throw error
    } catch (_: Throwable) {
      null
    }
  }

  private fun isCompletionRemoteOutcome(status: String): Boolean {
    return status in setOf("completing", "completed", "failed", "paused", "cancelled")
  }

  private suspend fun waitForCompletion(record: TransferRecord, runGeneration: Long) {
    var repairAttempt = 0
    while (true) {
      ensureCurrentRun(record, runGeneration)
      try {
        delay(1_000)
        val snapshot = getStatus(record)
        ensureCurrentRun(record, runGeneration)
        validateSnapshot(record, snapshot)
        applyRemoteSnapshot(record, snapshot, expectedRunGeneration = runGeneration)
        if (snapshot.status != "completing") return
        repairAttempt = 0
      } catch (error: CancellationException) {
        throw error
      } catch (error: Throwable) {
        val failure = toTransferRequestException(error)
        if (failure.code != "TRANSFER_ENDPOINT_UNAVAILABLE") throw failure
        markCompletionSyncIssue(record, runGeneration, failure.code)
        delay(RECOVERY_REPAIR_DELAYS_MS[minOf(repairAttempt, RECOVERY_REPAIR_DELAYS_MS.lastIndex)])
        repairAttempt += 1
      }
    }
  }

  private fun markCompletionSyncIssue(record: TransferRecord, runGeneration: Long, code: String) {
    val updated = synchronized(record.lock) {
      if (record.runGeneration != runGeneration || record.status != "completing") return@synchronized false
      record.errorCode = code
      record.errorDetails = null
      true
    }
    if (updated) emitState(record)
  }

  private suspend fun getStatus(
    record: TransferRecord,
    allowWhenRequestsBlocked: Boolean = false
  ): RemoteTransferSnapshot {
    val response = executeByteRequest(
      record,
      "GET",
      "/v3/transfers/${record.config.transferId}/status",
      ByteArray(0),
      emptyMap(),
      trackCall = true,
      allowWhenRequestsBlocked = allowWhenRequestsBlocked,
      useRepairClient = true
    )
    requireSuccess(response, setOf(200))
    return parseRemoteSnapshot(response.body, requiresChunkSize = false)
  }

  private suspend fun repairStatus(
    record: TransferRecord,
    expectedRunGeneration: Long? = null
  ): RemoteTransferSnapshot = record.statusRepairMutex.withLock {
    val now = SystemClock.elapsedRealtime()
    synchronized(record.lock) {
      val cached = record.lastRemoteSnapshot
      if (record.lastStatusRepairAtMs > 0L && now - record.lastStatusRepairAtMs < STATUS_REPAIR_MIN_INTERVAL_MS) {
        if (cached != null) return@withLock cached
        throw TransferRequestException("STATUS_REPAIR_RATE_LIMITED")
      }
      record.lastStatusRepairAtMs = now
    }
    val snapshot = getStatus(record)
    validateSnapshot(record, snapshot)
    applyRemoteSnapshot(record, snapshot, expectedRunGeneration = expectedRunGeneration)
    snapshot
  }

  private fun scheduleStatusRepair(
    record: TransferRecord,
    expectedRunGeneration: Long,
    reason: String
  ) {
    var emit = false
    var jobToStart: Job? = null
    synchronized(record.lock) {
      if (!isStatusRepairEligibleLocked(record, expectedRunGeneration)) return
      record.repairTargetRevision = max(record.repairTargetRevision, record.revision)
      if (!record.repairMode) {
        record.repairMode = true
        emit = true
      }
      record.repairReason = reason
      if (record.repairJob?.isActive != true) {
        val job = scope.launch(start = CoroutineStart.LAZY) {
          runStatusRepair(record, expectedRunGeneration)
        }
        record.repairJob = job
        jobToStart = job
      }
    }
    if (emit) emitState(record)
    jobToStart?.start()
  }

  private suspend fun runStatusRepair(record: TransferRecord, expectedRunGeneration: Long) {
    var attempt = 0
    try {
      while (true) {
        val keepRepairing = try {
          val snapshot = repairStatus(record, expectedRunGeneration)
          synchronized(record.lock) {
            if (!isStatusRepairEligibleLocked(record, expectedRunGeneration)) {
              false
            } else {
              // A status response must catch up to the local target and there
              // must no longer be a delayed ACK before repair can be cleared.
              snapshot.revision < record.repairTargetRevision || record.delayedChunkRequests > 0
            }
          }
        } catch (_: CancellationException) {
          return
        } catch (_: Throwable) {
          synchronized(record.lock) { isStatusRepairEligibleLocked(record, expectedRunGeneration) }
        }
        if (!keepRepairing) return

        // The initial repair is immediate. Subsequent requests are deliberately
        // no more frequent than the V3 five-second ceiling even though repair
        // state stays visible while the upload call remains pending.
        delay(maxOf(STATUS_REPAIR_MIN_INTERVAL_MS, RECOVERY_REPAIR_DELAYS_MS[minOf(attempt, RECOVERY_REPAIR_DELAYS_MS.lastIndex)]))
        attempt += 1
      }
    } finally {
      val cleared = synchronized(record.lock) {
        if (record.runGeneration != expectedRunGeneration || record.repairJob?.isActive == true && !coroutineContext.isActive) {
          false
        } else {
          record.repairJob = null
          val changed = record.repairMode || record.repairReason != null
          record.repairMode = false
          record.repairReason = null
          record.repairTargetRevision = record.revision
          changed
        }
      }
      if (cleared) emitState(record)
    }
  }

  private fun isStatusRepairEligibleLocked(record: TransferRecord, expectedRunGeneration: Long): Boolean {
    return !record.retired
      && record.runGeneration == expectedRunGeneration
      && !isTerminal(record.status)
      && record.status != "paused"
  }

  private fun beginAcknowledgementWatch(record: TransferRecord, expectedRunGeneration: Long): AcknowledgementWatch {
    val watch = synchronized(record.lock) {
      if (!isStatusRepairEligibleLocked(record, expectedRunGeneration) || record.requestsBlocked) {
        throw CancellationException("V3 chunk request blocked by transfer control.")
      }
      record.activeChunkRequests += 1
      AcknowledgementWatch(
        expectedRunGeneration = expectedRunGeneration,
        startedAtMs = SystemClock.elapsedRealtime(),
        thresholdMs = ackRepairThresholdMillis(record.lastRoundTripTimeMs)
      )
    }
    watch.watchdog = scope.launch {
      delay(ACK_SILENCE_REPAIR_DELAY_MS)
      markDelayedAcknowledgement(record, watch, "ACK_SILENCE")
      val remaining = watch.thresholdMs - ACK_SILENCE_REPAIR_DELAY_MS
      if (remaining > 0) delay(remaining)
      markDelayedAcknowledgement(record, watch, "ACK_DELAYED")
    }
    return watch
  }

  private fun markDelayedAcknowledgement(record: TransferRecord, watch: AcknowledgementWatch, reason: String) {
    if (watch.finished.get()) return
    val canRepair = synchronized(record.lock) {
      if (!isStatusRepairEligibleLocked(record, watch.expectedRunGeneration) || watch.finished.get()) {
        false
      } else {
        if (watch.delayed.compareAndSet(false, true)) record.delayedChunkRequests += 1
        true
      }
    }
    if (canRepair) scheduleStatusRepair(record, watch.expectedRunGeneration, reason)
  }

  private fun finishAcknowledgementWatch(
    record: TransferRecord,
    watch: AcknowledgementWatch,
    durableAcknowledgement: Boolean
  ) {
    if (!watch.finished.compareAndSet(false, true)) return
    watch.watchdog?.cancel()
    synchronized(record.lock) {
      record.activeChunkRequests = max(0, record.activeChunkRequests - 1)
      if (watch.delayed.get()) record.delayedChunkRequests = max(0, record.delayedChunkRequests - 1)
      if (durableAcknowledgement) {
        val elapsed = max(1L, SystemClock.elapsedRealtime() - watch.startedAtMs)
        record.lastRoundTripTimeMs = if (record.lastRoundTripTimeMs <= 0L) {
          elapsed
        } else {
          (record.lastRoundTripTimeMs * 7L + elapsed) / 8L
        }
      }
    }
  }

  private fun onNetworkChanged() {
    records.values.forEach { record ->
      val generation = synchronized(record.lock) { record.runGeneration }
      scheduleStatusRepair(record, generation, "NETWORK_CHANGED")
      scheduleCancelledReconciliation(record)
    }
  }

  private suspend fun postControl(
    record: TransferRecord,
    operation: String,
    trackActiveCall: Boolean = false
  ): ControlResponse {
    val response = executeByteRequest(
      record,
      "POST",
      "/v3/transfers/${record.config.transferId}/$operation",
      ByteArray(0),
      emptyMap(),
      trackCall = trackActiveCall,
      allowWhenRequestsBlocked = true
    )
    requireSuccess(response, setOf(200))
    try {
      val body = JSONObject(response.body)
      val status = body.getString("status")
      if (status !in setOf("paused", "transferring", "cancelled")) throw TransferRequestException("TRANSFER_PROTOCOL_ERROR")
      return ControlResponse(body.getLong("revision"), status)
    } catch (error: TransferRequestException) {
      throw error
    } catch (error: Throwable) {
      throw TransferRequestException("TRANSFER_PROTOCOL_ERROR", error)
    }
  }

  private suspend fun refreshAfterControl(record: TransferRecord, ticket: CommandTicket) {
    if (!isCurrentCommand(record, ticket.id)) return
    try {
      val snapshot = getStatus(record, allowWhenRequestsBlocked = true)
      validateSnapshot(record, snapshot)
      applyRemoteSnapshot(record, snapshot, expectedCommandId = ticket.id)
    } catch (error: Throwable) {
      // The control request was acknowledged. Keep its state and surface only
      // a status refresh failure; a later V3 status event can still reconcile it.
      if (isCurrentCommand(record, ticket.id)) emitFailure(record, toTransferRequestException(error).code)
    }
  }

  private suspend fun recoverAfterControlFailure(record: TransferRecord, error: Throwable, ticket: CommandTicket) {
    if (!isCurrentCommand(record, ticket.id)) return
    try {
      val snapshot = getStatus(record, allowWhenRequestsBlocked = true)
      validateSnapshot(record, snapshot)
      if (applyRemoteSnapshot(record, snapshot, expectedCommandId = ticket.id)) {
        launchRunForRemoteStatus(record, ticket.id, snapshot.status)
      }
    } catch (_: Throwable) {
      if (!restoreCommandState(record, ticket)) return
      emitFailure(record, toTransferRequestException(error).code)
      emitState(record)
      launchRunForRemoteStatus(record, ticket.id, ticket.previousStatus)
    }
  }

  private fun launchRunForRemoteStatus(record: TransferRecord, commandId: Long, status: String) {
    if (status == "completing") {
      val runGeneration = synchronized(record.lock) {
        if (
          records[record.config.transferId] !== record
          || record.retired
          || record.commandGeneration != commandId
        ) {
          return@synchronized null
        }
        record.runGeneration
      } ?: return
      scope.launch {
        waitForCompletion(record, runGeneration)
      }
      return
    }
    if (isRunEligibleStatus(status)) {
      launchRunIfIdle(record, expectedCommandGeneration = commandId)
    }
  }

  private fun scheduleCompletionReconciliationRestart(
    record: TransferRecord,
    expectedRunGeneration: Long,
    expectedCommandGeneration: Long,
    failure: TransferRequestException
  ) {
    var exhausted = false
    val scheduled = synchronized(record.lock) {
      when {
        record.runGeneration != expectedRunGeneration
          || record.commandGeneration != expectedCommandGeneration
          || record.retired
          || !isRunEligibleStatus(record.status) -> {
          false
        }
        record.completionReconciliationRestarts >= MAX_COMPLETION_RECONCILIATION_RESTARTS -> {
          // This transition shares the transfer lock with pause/resume, so a
          // stale completion retry cannot overwrite a newer control command.
          record.status = "failed"
          record.errorCode = failure.code
          record.errorDetails = failure.details
          exhausted = true
          false
        }
        else -> {
          record.completionReconciliationRestarts += 1
          true
        }
      }
    }
    if (exhausted) {
      emitFailure(record, failure.code)
      emitState(record)
      cleanupTerminalStaging(record, failure.code)
    }
    if (!scheduled) return

    scope.launch {
      while (true) {
        if (!isActiveRecord(record)) return@launch
        val state = synchronized(record.lock) {
          when {
            record.runGeneration != expectedRunGeneration
              || record.commandGeneration != expectedCommandGeneration
              || !isRunEligibleStatus(record.status) -> 0
            record.transferJob?.isActive == true -> 1
            else -> 2
          }
        }
        if (state == 0) return@launch
        if (state == 2) break
        delay(25)
      }
      delay(250)
      launchRunIfIdle(record, expectedRunGeneration, expectedCommandGeneration)
    }
  }

  private fun restoreCommandState(record: TransferRecord, ticket: CommandTicket): Boolean {
    return synchronized(record.lock) {
      if (record.commandGeneration != ticket.id) return@synchronized false
      record.pendingControlCommandId = null
      record.status = ticket.previousStatus
      record.errorCode = ticket.previousErrorCode
      record.errorDetails = ticket.previousErrorDetails
      true
    }
  }

  private fun applyControlResponse(record: TransferRecord, response: ControlResponse, expectedCommandId: Long): Boolean {
    val applied = synchronized(record.lock) {
      if (record.commandGeneration != expectedCommandId || response.revision < record.revision) return@synchronized false
      record.revision = response.revision
      record.pendingControlCommandId = null
      record.status = response.status
      record.errorCode = null
      record.errorDetails = null
      if (response.status == "transferring") record.completionReconciliationRestarts = 0
      true
    }
    if (applied) {
      emitState(record)
      emitProgress(record, force = true)
    }
    return applied
  }

  private fun applyRemoteSnapshot(
    record: TransferRecord,
    snapshot: RemoteTransferSnapshot,
    expectedRunGeneration: Long? = null,
    expectedCommandId: Long? = null
  ): Boolean {
    var terminalErrorCode: String? = null
    var remoteFailureCode: String? = null
    val applied = synchronized(record.lock) {
      if (expectedRunGeneration != null && record.runGeneration != expectedRunGeneration) return@synchronized false
      if (expectedCommandId != null && record.commandGeneration != expectedCommandId) return@synchronized false
      if (snapshot.revision < record.revision) return@synchronized false
      val totalBytes = record.config.items.sumOf { it.sizeBytes }
      record.lastRemoteSnapshot = snapshot
      if (expectedCommandId != null) record.pendingControlCommandId = null
      record.revision = snapshot.revision
      record.confirmedBytes = minOf(totalBytes, max(record.confirmedBytes, snapshot.transferReceivedBytes))
      record.submittedBytes = minOf(totalBytes, max(record.submittedBytes, record.confirmedBytes))
      val retainRecovering = record.status == "recovering"
        && snapshot.status in setOf("negotiating", "queued", "waiting_for_peer", "preparing", "recovering", "transferring")
      if (!retainRecovering) record.status = snapshot.status
      record.errorCode = snapshot.errorCode ?: if (snapshot.status == "failed") "TRANSFER_FAILED" else null
      record.errorDetails = null
      record.verifyingBytes = max(record.verifyingBytes, snapshot.verifyingBytes)
      record.verifyingTotalBytes = max(record.verifyingTotalBytes, snapshot.verifyingTotalBytes)
      record.verifyingPhase = snapshot.verifyingPhase
      if (snapshot.status in setOf("completing", "completed", "failed")) {
        record.completionReconciliationRestarts = 0
      }
      if (isTerminal(snapshot.status)) {
        terminalErrorCode = record.errorCode
        if (snapshot.status == "failed") remoteFailureCode = record.errorCode
      }
      true
    }
    if (applied) {
      emitState(record)
      emitProgress(record, force = true)
      remoteFailureCode?.let { emitFailure(record, it) }
      cleanupTerminalStaging(record, terminalErrorCode)
    }
    return applied
  }

  private fun applyTransientRemoteSnapshot(record: TransferRecord, snapshot: RemoteTransferSnapshot) {
    synchronized(record.lock) {
      if (snapshot.revision < record.revision) throw TransferRequestException("TRANSFER_PROTOCOL_ERROR")
      val totalBytes = record.config.items.sumOf { it.sizeBytes }
      record.lastRemoteSnapshot = snapshot
      record.revision = snapshot.revision
      record.confirmedBytes = minOf(totalBytes, max(record.confirmedBytes, snapshot.transferReceivedBytes))
      record.submittedBytes = minOf(totalBytes, max(record.submittedBytes, record.confirmedBytes))
      record.status = snapshot.status
      record.errorCode = snapshot.errorCode ?: if (snapshot.status == "failed") "TRANSFER_FAILED" else null
      record.errorDetails = null
      record.verifyingBytes = max(record.verifyingBytes, snapshot.verifyingBytes)
      record.verifyingTotalBytes = max(record.verifyingTotalBytes, snapshot.verifyingTotalBytes)
      record.verifyingPhase = snapshot.verifyingPhase
    }
  }

  private fun applyChunkAcknowledgement(record: TransferRecord, acknowledgement: ChunkAcknowledgement, expectedRunGeneration: Long) {
    val applied = synchronized(record.lock) {
      if (record.runGeneration != expectedRunGeneration || acknowledgement.revision < record.revision) return@synchronized false
      val totalBytes = record.config.items.sumOf { it.sizeBytes }
      val now = System.currentTimeMillis()
      val previousBytes = record.confirmedBytes
      val previousTime = record.lastAcknowledgementAtMs
      record.revision = acknowledgement.revision
      record.confirmedBytes = minOf(totalBytes, max(record.confirmedBytes, acknowledgement.transferReceivedBytes))
      record.submittedBytes = minOf(totalBytes, max(record.submittedBytes, record.confirmedBytes))
      if (record.confirmedBytes > previousBytes && previousTime > 0 && now > previousTime) {
        val instantaneous = (record.confirmedBytes - previousBytes) * 1_000L / (now - previousTime)
        record.confirmedRateBytesPerSecond = if (record.confirmedRateBytesPerSecond == 0L) {
          instantaneous
        } else {
          (record.confirmedRateBytesPerSecond * 65L + instantaneous * 35L) / 100L
        }
      }
      record.lastAcknowledgementAtMs = now
      if (!isTerminal(record.status) && record.status != "paused") record.status = "transferring"
      true
    }
    if (applied) emitProgress(record)
  }

  private fun addSubmitted(record: TransferRecord, itemId: String, chunkIndex: Int, bytes: Long) {
    val changed = synchronized(record.lock) {
      if (!record.submittedChunks.add(ChunkIdentity(itemId, chunkIndex))) return@synchronized false
      val totalBytes = record.config.items.sumOf { it.sizeBytes }
      record.submittedBytes = minOf(totalBytes, record.submittedBytes + bytes)
      true
    }
    if (changed) emitProgress(record)
  }

  private fun updateRecoveryManifest(
    record: TransferRecord,
    entries: Int,
    total: Int,
    force: Boolean = false
  ) {
    require(entries >= 0 && total >= 0 && entries <= total) { "Invalid recovery manifest progress." }
    synchronized(record.lock) {
      record.recoveryManifestEntries = max(record.recoveryManifestEntries, entries)
      record.recoveryManifestTotal = max(record.recoveryManifestTotal, total)
    }
    emitProgress(record, force)
  }

  private fun cachedChunkDigest(
    record: TransferRecord,
    itemId: String,
    chunkIndex: Int,
    expectedLength: Int
  ): V3ChunkDigest? {
    return synchronized(record.lock) {
      record.chunkDigests[itemId]?.get(chunkIndex)?.takeIf { it.length == expectedLength && it.sha256.size == 32 }
    }
  }

  private fun hasCachedChunkDigests(record: TransferRecord): Boolean {
    return synchronized(record.lock) { record.chunkDigests.values.any { it.isNotEmpty() } }
  }

  private fun cacheChunkDigest(
    record: TransferRecord,
    itemId: String,
    digest: V3ChunkDigest,
    confirmedRevision: Long? = null
  ) {
    synchronized(record.lock) {
      record.chunkDigests.getOrPut(itemId) { mutableMapOf() }[digest.index] = digest
      confirmedRevision?.let { revision ->
        record.chunkDigestRevisions.getOrPut(itemId) { mutableMapOf() }[digest.index] = revision
      }
    }
  }

  private fun cacheAgentConfirmedChunkDigest(record: TransferRecord, itemId: String, digest: V3ChunkDigest) {
    val mismatch = synchronized(record.lock) {
      record.persistedChunkDigests[itemId]?.get(digest.index)?.let { persisted ->
        chunkDigestMismatchDetails(itemId, persisted, digest)
      }
    }
    if (mismatch != null) {
      throw TransferRequestException("CHUNK_DIGEST_MISMATCH", details = mismatch)
    }
    cacheChunkDigest(record, itemId, digest, synchronized(record.lock) { max(0L, record.revision) })
  }

  private fun recordDurableChunkDigest(
    record: TransferRecord,
    itemId: String,
    digest: V3ChunkDigest,
    acknowledgement: ChunkAcknowledgement,
    expectedRunGeneration: Long
  ) {
    val current = synchronized(record.lock) {
      if (record.runGeneration != expectedRunGeneration || record.retired) {
        return@synchronized false
      }
      record.chunkDigests.getOrPut(itemId) { mutableMapOf() }[digest.index] = digest
      record.chunkDigestRevisions.getOrPut(itemId) { mutableMapOf() }[digest.index] = acknowledgement.revision
      true
    }
    if (current) {
      // A digest reaches React Native only once the Agent has ACKed the chunk
      // as durable. The event's confirmation revision remains the Agent ACK,
      // even if a concurrent ACK has already advanced the transfer revision.
      emitConfirmedDigests(record, listOf(ConfirmedChunkDigest(itemId, digest)), acknowledgement.revision)
    }
  }

  private fun emitConfirmedDigests(
    record: TransferRecord,
    confirmedDigests: List<ConfirmedChunkDigest>,
    confirmedRevision: Long? = null
  ) {
    if (confirmedDigests.isEmpty() || !isActiveRecord(record)) return
    val (eventRevision, eventOperationGeneration) = synchronized(record.lock) {
      Pair(
        max(0L, max(record.revision, confirmedRevision ?: record.revision)),
        record.runGeneration
      )
    }
    confirmedDigests.chunked(MAX_DIGEST_EVENT_BATCH).forEach { batch ->
      val entries = batch.map { confirmed ->
        require(confirmed.digest.sha256.size == 32) { "Invalid confirmed chunk digest." }
        mapOf(
          "confirmedRevision" to max(0L, confirmedRevision ?: eventRevision),
          "index" to confirmed.digest.index,
          "itemId" to confirmed.itemId,
          "length" to confirmed.digest.length,
          "sha256" to confirmed.digest.sha256.toV3LowerHex()
        )
      }
      dispatch(
        "transferChunkDigests",
        mapOf(
          "digests" to entries,
          "operationGeneration" to eventOperationGeneration,
          "operationId" to record.operationId,
          "revision" to eventRevision,
          "transferId" to record.config.transferId
        )
      )
    }
  }

  private fun handleRunFailure(
    record: TransferRecord,
    runGeneration: Long,
    commandGeneration: Long,
    error: Throwable
  ) {
    val failure = toTransferRequestException(error)
    if (
      failure.code == "TRANSFER_PAUSED"
      || failure.code == "TRANSFER_CLOSING"
      || failure.code == "TRANSFER_INCOMPLETE"
      || failure.code == "TRANSFER_COMPLETION_CONFLICT"
    ) {
      scope.launch {
        try {
          val snapshot = getStatus(record)
          validateSnapshot(record, snapshot)
          applyRemoteSnapshot(record, snapshot, expectedRunGeneration = runGeneration)
          if (snapshot.status == "completing") {
            waitForCompletion(record, runGeneration)
          } else if (
            (failure.code == "TRANSFER_INCOMPLETE" || failure.code == "TRANSFER_COMPLETION_CONFLICT")
            && isRunEligibleStatus(snapshot.status)
          ) {
            scheduleCompletionReconciliationRestart(record, runGeneration, commandGeneration, failure)
          }
        } catch (_: Throwable) {
          fail(record, runGeneration, failure, commandGeneration)
        }
      }
      return
    }
    fail(record, runGeneration, failure, commandGeneration)
  }

  private fun fail(
    record: TransferRecord,
    expectedRunGeneration: Long,
    error: Throwable,
    expectedCommandGeneration: Long? = null
  ) {
    val failure = toTransferRequestException(error)
    val failed = synchronized(record.lock) {
      if (
        record.runGeneration != expectedRunGeneration
        || (expectedCommandGeneration != null && record.commandGeneration != expectedCommandGeneration)
        || record.status == "paused"
        || record.status == "cancelled"
      ) {
        return@synchronized false
      }
      record.status = if (failure.code == "TRANSFER_ENDPOINT_UNAVAILABLE") "waiting_for_peer" else "failed"
      record.errorCode = failure.code
      record.errorDetails = failure.details
      true
    }
    if (failed) {
      emitFailure(record, failure.code, failure.details)
      emitState(record)
      cleanupTerminalStaging(record, failure.code)
    }
  }

  private fun updateStatus(record: TransferRecord, status: String, optimistic: Boolean = false) {
    synchronized(record.lock) {
      record.status = status
      if (isTerminal(status)) {
        record.errorCode = null
        record.errorDetails = null
      }
    }
    emitState(record, optimistic)
  }

  private fun emitState(record: TransferRecord, optimistic: Boolean = false) {
    val payload = synchronized(record.lock) { snapshotMap(record, optimistic) }
    dispatch("transferState", payload)
  }

  private fun emitProgress(record: TransferRecord, force: Boolean = false) {
    val payload = synchronized(record.lock) {
      val now = System.currentTimeMillis()
      val bytesAdvanced = record.confirmedBytes - record.lastProgressBytes
      val submittedBytesAdvanced = record.submittedBytes - record.lastProgressSubmittedBytes
      if (
        !force
        && now - record.lastProgressEventAtMs < PROGRESS_TIME_STEP_MS
        && bytesAdvanced < PROGRESS_BYTES_STEP
        && submittedBytesAdvanced < PROGRESS_BYTES_STEP
      ) {
        null
      } else {
        record.lastProgressEventAtMs = now
        record.lastProgressBytes = record.confirmedBytes
        record.lastProgressSubmittedBytes = record.submittedBytes
        snapshotMap(record, optimistic = false)
      }
    }
    if (payload != null) dispatch("transferProgress", payload)
  }

  private fun emitFailure(record: TransferRecord, code: String, details: Map<String, Any>? = null) {
    val payload = synchronized(record.lock) {
      snapshotMap(record, optimistic = false).toMutableMap().apply {
        put("errorCode", code)
        (details ?: record.errorDetails)?.let { failureDetails ->
          put("errorDetails", failureDetails)
          if (code == "CHUNK_DIGEST_MISMATCH") put("chunkDigestMismatches", listOf(failureDetails))
        }
      }
    }
    dispatch("transferFailure", payload)
  }

  private fun dispatch(eventName: String, payload: Map<String, Any>) {
    try {
      eventSink?.invoke(eventName, payload)
    } catch (_: Throwable) {
      // A React bridge can disappear while the application-scope controller is alive.
    }
  }

  private fun snapshotMap(record: TransferRecord, optimistic: Boolean): Map<String, Any> {
    return buildMap {
      put("confirmedBytes", record.confirmedBytes)
      put("confirmedRateBytesPerSecond", record.confirmedRateBytesPerSecond)
      put("operationGeneration", record.runGeneration)
      put("operationId", record.operationId)
      put("optimistic", optimistic || record.pendingControlCommandId != null)
      put("repairMode", record.repairMode)
      put("recoveryManifestEntries", record.recoveryManifestEntries)
      put("recoveryManifestTotal", record.recoveryManifestTotal)
      put("revision", max(0L, record.revision))
      put("status", record.status)
      put("submittedBytes", record.submittedBytes)
      put("transferId", record.config.transferId)
      put("verifyingBytes", record.verifyingBytes)
      put("verifyingPhase", record.verifyingPhase)
      put("verifyingTotalBytes", record.verifyingTotalBytes)
      record.errorCode?.let { put("errorCode", it) }
      record.errorDetails?.let { details ->
        put("errorDetails", details)
        if (record.errorCode == "CHUNK_DIGEST_MISMATCH") put("chunkDigestMismatches", listOf(details))
      }
    }
  }

  private suspend fun ensureCurrentRun(record: TransferRecord, expectedRunGeneration: Long) {
    coroutineContext.ensureActive()
    val current = synchronized(record.lock) { record.runGeneration == expectedRunGeneration }
    if (!current) throw CancellationException("Superseded V3 transfer operation.")
  }

  private fun isCurrentCommand(record: TransferRecord, expectedCommandId: Long): Boolean {
    return synchronized(record.lock) { record.commandGeneration == expectedCommandId }
  }

  private suspend fun executeByteRequest(
    record: TransferRecord,
    method: String,
    path: String,
    body: ByteArray,
    headers: Map<String, String>,
    trackCall: Boolean,
    allowWhenRequestsBlocked: Boolean = false,
    useRepairClient: Boolean = false
  ): HttpResponseData {
    val requestBody = if (method == "GET") null else ByteArrayRequestBody(body, headers["Content-Type"]?.toMediaType())
    return executeSigned(
      record,
      method,
      path,
      requestBody,
      V3TransferProtocol.sha256(body).toV3LowerHex(),
      headers,
      trackCall,
      allowWhenRequestsBlocked,
      useRepairClient
    )
  }

  private suspend fun executeSigned(
    record: TransferRecord,
    method: String,
    path: String,
    requestBody: RequestBody?,
    bodySha256Hex: String,
    headers: Map<String, String>,
    trackCall: Boolean,
    allowWhenRequestsBlocked: Boolean = false,
    useRepairClient: Boolean = false
  ): HttpResponseData {
    val request = Request.Builder()
      .url(httpUrl(record, path))
      .method(method, requestBody)
      .header(
        "Authorization",
        V3TransferProtocol.authorizationForBodySha256(record.config.transferSecretHex, method, path, bodySha256Hex)
      )
      .header("X-FlowDrop-Source-Device-Id", record.config.sourceDeviceId)
      .apply { headers.forEach { (name, value) -> header(name, value) } }
      .build()
    val call = (if (useRepairClient) repairClient else client).newCall(request)
    val accepted = synchronized(record.lock) {
      if (record.retired || (record.requestsBlocked && !allowWhenRequestsBlocked)) {
        false
      } else {
        if (trackCall) record.activeCalls += call
        true
      }
    }
    if (!accepted) {
      call.cancel()
      throw CancellationException("V3 request blocked by transfer control.")
    }
    try {
      call.execute().use { response ->
        return HttpResponseData(response.code, response.body?.string().orEmpty())
      }
    } catch (error: IOException) {
      if (call.isCanceled()) throw CancellationException("V3 request cancelled.")
      if (error is TransferRequestException) throw error
      throw TransferRequestException("TRANSFER_ENDPOINT_UNAVAILABLE", error)
    } finally {
      if (trackCall) synchronized(record.lock) { record.activeCalls.remove(call) }
    }
  }

  private fun httpUrl(record: TransferRecord, requestTarget: String): HttpUrl {
    return v3HttpUrl(record.config.peerAddress, record.config.peerControlPort, requestTarget)
  }

  private fun requireSuccess(response: HttpResponseData, expectedStatuses: Set<Int>) {
    if (response.statusCode in expectedStatuses) return
    if (response.statusCode in 500..599) throw TransferRequestException("TRANSFER_ENDPOINT_UNAVAILABLE")
    throw TransferRequestException(response.errorCode() ?: "TRANSFER_ENDPOINT_UNAVAILABLE")
  }

  private fun parseRemoteSnapshot(bodyString: String, requiresChunkSize: Boolean): RemoteTransferSnapshot {
    try {
      val body = JSONObject(bodyString)
      val chunkSizeBytes = if (body.has("chunkSizeBytes") && !body.isNull("chunkSizeBytes")) body.getInt("chunkSizeBytes") else null
      if (requiresChunkSize && chunkSizeBytes == null) throw TransferRequestException("TRANSFER_PROTOCOL_ERROR")
      val receivedRanges = mutableMapOf<String, List<IntRange>>()
      body.optJSONArray("items")?.let { items ->
        for (index in 0 until items.length()) {
          val item = items.getJSONObject(index)
          receivedRanges[item.getString("itemId")] = parseRanges(item.optJSONArray("receivedRanges"))
        }
      }
      val revision = body.getLong("revision")
      val status = body.getString("status")
      val transferReceivedBytes = body.getLong("transferReceivedBytes")
      val verifyingBytes = if (body.has("verifyingBytes") && !body.isNull("verifyingBytes")) body.getLong("verifyingBytes") else 0L
      val verifyingPhase = if (body.has("verifyingPhase") && !body.isNull("verifyingPhase")) body.getString("verifyingPhase") else "idle"
      val verifyingTotalBytes = if (body.has("verifyingTotalBytes") && !body.isNull("verifyingTotalBytes")) body.getLong("verifyingTotalBytes") else 0L
      if (
        revision < 0
        || transferReceivedBytes < 0
        || verifyingBytes < 0
        || verifyingTotalBytes < 0
        || verifyingBytes > verifyingTotalBytes
        || verifyingPhase !in setOf("idle", "reading", "hashing", "done")
        || !isKnownStatus(status)
      ) {
        throw TransferRequestException("TRANSFER_PROTOCOL_ERROR")
      }
      return RemoteTransferSnapshot(
        chunkSizeBytes = chunkSizeBytes,
        errorCode = body.optString("errorCode").takeIf { it.isNotBlank() },
        receivedRanges = receivedRanges,
        revision = revision,
        status = status,
        transferReceivedBytes = transferReceivedBytes,
        verifyingBytes = verifyingBytes,
        verifyingPhase = verifyingPhase,
        verifyingTotalBytes = verifyingTotalBytes
      )
    } catch (error: TransferRequestException) {
      throw error
    } catch (error: Throwable) {
      throw TransferRequestException("TRANSFER_PROTOCOL_ERROR", error)
    }
  }

  private fun validateSnapshot(record: TransferRecord, snapshot: RemoteTransferSnapshot) {
    val totalBytes = record.config.items.sumOf { it.sizeBytes }
    if (snapshot.transferReceivedBytes !in 0..totalBytes) throw TransferRequestException("TRANSFER_PROTOCOL_ERROR")
  }

  private fun parseRanges(ranges: JSONArray?): List<IntRange> {
    if (ranges == null) return emptyList()
    return buildList {
      var previousEnd = -1
      for (index in 0 until ranges.length()) {
        val range = ranges.getJSONArray(index)
        val start = range.getInt(0)
        val end = range.getInt(1)
        if (start < 0 || end < start || start <= previousEnd) throw TransferRequestException("TRANSFER_PROTOCOL_ERROR")
        add(start..end)
        previousEnd = end
      }
    }
  }

  private fun isReceived(ranges: List<IntRange>, chunkIndex: Int) = ranges.any { chunkIndex in it }

  private fun receivedIndexes(ranges: List<IntRange>, chunkCount: Int): Set<Int> = buildSet {
    for (range in ranges) {
      if (range.first < 0 || range.last >= chunkCount) throw TransferRequestException("TRANSFER_PROTOCOL_ERROR")
      for (index in range) add(index)
    }
  }

  private fun JSONArray.toIntSet(): Set<Int> = buildSet {
    for (index in 0 until length()) add(getInt(index))
  }

  private fun HttpResponseData.errorCode(): String? {
    return try {
      JSONObject(body).optString("code").takeIf { it.isNotBlank() }
    } catch (_: Throwable) {
      null
    }
  }

  private fun toTransferRequestException(error: Throwable?): TransferRequestException {
    return when (error) {
      is TransferRequestException -> error
      is CancellationException -> TransferRequestException("TRANSFER_CANCELLED", error)
      else -> TransferRequestException("TRANSFER_ENDPOINT_UNAVAILABLE", error)
    }
  }

  private fun isKnownStatus(status: String): Boolean = status in setOf(
    "negotiating", "queued", "waiting_for_peer", "preparing", "recovering", "transferring", "paused", "completing", "completed", "failed", "cancelled"
  )

  private fun isRunEligibleStatus(status: String): Boolean = status in setOf(
    "negotiating", "queued", "waiting_for_peer", "preparing", "recovering", "transferring"
  )

  private fun isTerminal(status: String) = status == "completed" || status == "failed" || status == "cancelled"

  override fun onTrimMemory(level: Int) {
    if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
      enterMemoryPressure()
      shrinkActiveChunkWindows()
    }
    if (level >= ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN) {
      val epoch = enterBackground()
      records.values.forEach { record -> pauseForBackground(record, epoch) }
    }
  }

  override fun onActivityResumed(activity: Activity) {
    // The controller can be created after this Activity has already started.
    // Treat resume as evidence that the process is foregrounded in that case.
    synchronized(backgroundLock) {
      startedActivityCount = max(1, startedActivityCount)
    }
    allowForegroundUploads()
  }

  override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit

  override fun onActivityStarted(activity: Activity) {
    synchronized(backgroundLock) {
      startedActivityCount += 1
    }
  }

  override fun onActivityPaused(activity: Activity) = Unit

  override fun onActivityStopped(activity: Activity) {
    val foregroundEpoch = synchronized(backgroundLock) {
      startedActivityCount = max(0, startedActivityCount - 1)
      if (startedActivityCount > 0 || activity.isChangingConfigurations) null else backgroundEpoch
    } ?: return

    // Navigation/configuration can briefly leave no started Activity. Defer
    // the pause so a replacement Activity can re-establish foreground state.
    scope.launch {
      delay(ACTIVITY_BACKGROUND_GRACE_MS)
      val epoch = enterBackgroundIfStillInactive(foregroundEpoch) ?: return@launch
      records.values.forEach { record -> pauseForBackground(record, epoch) }
    }
  }

  override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

  override fun onActivityDestroyed(activity: Activity) = Unit

  override fun onLowMemory() {
    enterMemoryPressure()
    shrinkActiveChunkWindows()
  }

  override fun onConfigurationChanged(newConfig: Configuration) = Unit

  private fun shrinkActiveChunkWindows() {
    records.values.forEach { record ->
      val windows = synchronized(record.lock) { record.activeChunkWindows.toList() }
      windows.forEach { it.shrinkForMemoryPressure() }
    }
  }

  private fun allowForegroundUploads() {
    synchronized(backgroundLock) {
      uploadsPausedForBackground = false
      backgroundEpoch += 1
    }
    synchronized(memoryPressureLock) {
      memoryPressureCeiling = MAX_NATIVE_IN_FLIGHT_CHUNKS
    }
    records.values.forEach { record ->
      val generation = synchronized(record.lock) { record.runGeneration }
      scheduleStatusRepair(record, generation, "FOREGROUND")
      scheduleCancelledReconciliation(record)
    }
  }

  private fun enterBackground(): Long = synchronized(backgroundLock) {
    if (uploadsPausedForBackground) return@synchronized backgroundEpoch
    uploadsPausedForBackground = true
    backgroundEpoch += 1
    backgroundEpoch
  }

  private fun enterBackgroundIfStillInactive(expectedForegroundEpoch: Long): Long? = synchronized(backgroundLock) {
    if (startedActivityCount > 0 || backgroundEpoch != expectedForegroundEpoch) return@synchronized null
    if (uploadsPausedForBackground) return@synchronized backgroundEpoch
    uploadsPausedForBackground = true
    backgroundEpoch += 1
    backgroundEpoch
  }

  private fun isCurrentBackgroundEpoch(epoch: Long): Boolean = synchronized(backgroundLock) {
    uploadsPausedForBackground && backgroundEpoch == epoch
  }

  private fun enterMemoryPressure() {
    synchronized(memoryPressureLock) {
      memoryPressureCeiling = 1
    }
  }

  private fun currentMemoryPressureCeiling(maximum: Int): Int = synchronized(memoryPressureLock) {
    minOf(maximum, memoryPressureCeiling)
  }

  private fun pauseForBackground(record: TransferRecord, epoch: Long) {
    val prepared = synchronized(record.lock) {
      if (
        !isCurrentBackgroundEpoch(epoch)
        || records[record.config.transferId] !== record
        || record.retired
        || !isRunEligibleStatus(record.status)
      ) {
        return@synchronized null
      }
      record.commandGeneration += 1
      val ticket = CommandTicket(record.commandGeneration, record.errorDetails, record.errorCode, record.status)
      record.pendingControlCommandId = record.commandGeneration
      record.status = "paused"
      record.errorCode = null
      record.errorDetails = null
      val predecessor = record.commandTail
      val tail = CompletableDeferred<Unit>()
      record.commandTail = tail
      PreparedBackgroundPause(
        queued = QueuedControl(predecessor, CompletableDeferred<ControlResponse>(), tail, ticket),
        stoppedRun = stopRunAndBlockLocked(record)
      )
    } ?: return

    cancelStoppedRun(prepared.stoppedRun)
    emitState(record, optimistic = true)
    launchBackgroundPause(record, prepared.queued)
  }

  private fun launchBackgroundPause(record: TransferRecord, queued: QueuedControl) {
    scope.launch {
      try {
        queued.predecessor.await()
        val response = postBackgroundPause(record, queued.ticket)
        if (response == null) {
          queued.result.cancel()
          return@launch
        }
        if (!isCurrentBackgroundPause(record, queued.ticket.id)) {
          queued.result.cancel()
          return@launch
        }
        applyControlResponse(record, response, queued.ticket.id)
        queued.result.complete(response)
      } catch (error: Throwable) {
        if (isActiveRecord(record) && isCurrentBackgroundPause(record, queued.ticket.id)) {
          recoverAfterControlFailure(record, error, queued.ticket)
        }
        queued.result.completeExceptionally(error)
      } finally {
        queued.tail.complete(Unit)
      }
    }
  }

  private suspend fun postBackgroundPause(record: TransferRecord, ticket: CommandTicket): ControlResponse? {
    var retryAttempt = 0
    while (isCurrentBackgroundPause(record, ticket.id)) {
      try {
        // Controls are serialized by commandTail; do not put a predecessor
        // control into the uploader Call set, or a following cancel could
        // abort it and leave the queue waiting forever.
        val response = postControl(record, "pause", trackActiveCall = false)
        return response.takeIf { isCurrentBackgroundPause(record, ticket.id) }
      } catch (error: CancellationException) {
        throw error
      } catch (error: Throwable) {
        val failure = toTransferRequestException(error)
        if (!isCurrentBackgroundPause(record, ticket.id)) return null
        markBackgroundPauseSyncIssue(record, ticket, failure.code)
        if (failure.code != "TRANSFER_ENDPOINT_UNAVAILABLE") {
          reconcileBackgroundPauseFailure(record, ticket)
          throw failure
        }
        delay(RECOVERY_REPAIR_DELAYS_MS[minOf(retryAttempt, RECOVERY_REPAIR_DELAYS_MS.lastIndex)])
        retryAttempt += 1
      }
    }
    return null
  }

  private fun markBackgroundPauseSyncIssue(record: TransferRecord, ticket: CommandTicket, code: String) {
    val updated = synchronized(record.lock) {
      if (
        record.retired
        || record.commandGeneration != ticket.id
        || record.status != "paused"
        || record.errorCode == code
      ) {
        return@synchronized false
      }
      record.errorCode = code
      record.errorDetails = null
      true
    }
    if (updated) {
      emitFailure(record, code)
      emitState(record)
    }
  }

  private suspend fun reconcileBackgroundPauseFailure(record: TransferRecord, ticket: CommandTicket) {
    try {
      val snapshot = getStatus(record, allowWhenRequestsBlocked = true)
      validateSnapshot(record, snapshot)
      if (
        snapshot.status in setOf("paused", "completing", "completed", "failed", "cancelled")
        && isCurrentBackgroundPause(record, ticket.id)
      ) {
        applyRemoteSnapshot(record, snapshot, expectedCommandId = ticket.id)
      }
    } catch (_: Throwable) {
      // Keep the local pause and its sync error; foreground resume will repair it.
    }
  }

  private fun isCurrentBackgroundPause(record: TransferRecord, commandId: Long): Boolean {
    if (records[record.config.transferId] !== record) return false
    return synchronized(record.lock) { !record.retired && record.commandGeneration == commandId }
  }
}

object TransferControllerRegistry {
  private var controller: TransferController? = null

  @Synchronized
  fun get(context: Context, sink: (String, Map<String, Any>) -> Unit): TransferController {
    val applicationContext = context.applicationContext
    val current = controller ?: TransferController(applicationContext).also { controller = it }
    current.setEventSink(sink)
    return current
  }
}

internal fun v3HttpUrl(peerAddress: String, peerControlPort: Int, requestTarget: String): HttpUrl {
  val separator = requestTarget.indexOf('?')
  val path = if (separator < 0) requestTarget else requestTarget.substring(0, separator)
  val query = if (separator < 0) null else requestTarget.substring(separator + 1)
  require(path.startsWith('/') && !path.contains('#') && query?.contains('?') != true) { "Invalid V3 request target." }
  val builder = HttpUrl.Builder()
    .scheme("http")
    .host(peerAddress)
    .port(peerControlPort)
    .encodedPath(path)
  if (query != null) builder.encodedQuery(query)
  return builder.build()
}

package com.flowdrop.network

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

data class V3CreateItem(
  val itemId: String,
  val mimeType: String,
  val name: String,
  val sizeBytes: Long
)

data class V3CompletionFile(
  val contentRoot: String,
  val itemId: String
)

data class V3ChunkDigest(
  val index: Int,
  val length: Int,
  val sha256: ByteArray
)

fun ByteArray.toV3LowerHex(): String {
  val output = CharArray(size * 2)
  val digits = "0123456789abcdef"
  forEachIndexed { index, byte ->
    val value = byte.toInt() and 0xff
    output[index * 2] = digits[value ushr 4]
    output[index * 2 + 1] = digits[value and 0x0f]
  }
  return String(output)
}

object V3TransferProtocol {
  const val DEFAULT_CHUNK_BYTES = 1024 * 1024
  const val MAX_CHUNK_BYTES = 4 * 1024 * 1024
  const val MIN_CHUNK_BYTES = 1024 * 1024
  const val PROTOCOL = 3

  private val leafPrefix = "FlowDrop-V3-leaf".toByteArray(StandardCharsets.US_ASCII) + byteArrayOf(0)
  private val rootPrefix = "FlowDrop-V3-root".toByteArray(StandardCharsets.US_ASCII) + byteArrayOf(0)

  fun authorization(secretHex: String, method: String, path: String, body: ByteArray): String {
    return authorizationForBodySha256(secretHex, method, path, sha256(body).toV3LowerHex())
  }

  fun authorizationForBodySha256(
    secretHex: String,
    method: String,
    path: String,
    bodySha256Hex: String
  ): String {
    val timestamp = System.currentTimeMillis().toString()
    val nonce = UUID.randomUUID().toString()
    val signature = requestSignatureForBodySha256(secretHex, method, path, timestamp, nonce, bodySha256Hex)
    return "FlowDrop-HMAC $timestamp:$nonce:$signature"
  }

  fun requestSignature(
    secretHex: String,
    method: String,
    path: String,
    timestamp: String,
    nonce: String,
    body: ByteArray
  ): String {
    return requestSignatureForBodySha256(secretHex, method, path, timestamp, nonce, sha256(body).toV3LowerHex())
  }

  fun requestSignatureForBodySha256(
    secretHex: String,
    method: String,
    path: String,
    timestamp: String,
    nonce: String,
    bodySha256Hex: String
  ): String {
    require(method.isNotEmpty()) { "A request method is required." }
    require(path.startsWith('/')) { "A request path is required." }
    require(timestamp.matches(Regex("^(0|[1-9]\\d{0,15})$"))) { "Invalid V3 timestamp." }
    require(nonce.matches(Regex("^[A-Za-z0-9._~-]{1,128}$"))) { "Invalid V3 nonce." }
    require(bodySha256Hex.matches(Regex("^[a-f0-9]{64}$"))) { "Invalid V3 request body hash." }
    val key = decodeHex(secretHex)
    require(key.size == 32) { "Invalid V3 transfer credential." }
    val message = "$method\n$path\n$timestamp\n$nonce\n$bodySha256Hex".toByteArray(StandardCharsets.UTF_8)
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(key, "HmacSHA256"))
    return mac.doFinal(message).toV3LowerHex()
  }

  fun canonicalCreateBody(
    transferId: String,
    sourceDeviceId: String,
    chunkSizeBytes: Int,
    items: List<V3CreateItem>
  ): ByteArray {
    require(chunkSizeBytes in MIN_CHUNK_BYTES..MAX_CHUNK_BYTES) { "Invalid V3 chunk size." }
    require(items.isNotEmpty()) { "A V3 transfer needs at least one item." }
    val body = buildString {
      append("{\"chunkSizeBytes\":")
      append(chunkSizeBytes)
      append(",\"items\":[")
      items.forEachIndexed { index, item ->
        if (index > 0) append(',')
        require(item.sizeBytes >= 0) { "Invalid item size." }
        append("{\"itemId\":")
        append(jsonString(item.itemId))
        append(",\"mimeType\":")
        append(jsonString(item.mimeType))
        append(",\"name\":")
        append(jsonString(item.name))
        append(",\"sizeBytes\":")
        append(item.sizeBytes)
        append('}')
      }
      append(",\"protocol\":")
      append(PROTOCOL)
      append(",\"sourceDeviceId\":")
      append(jsonString(sourceDeviceId))
      append(",\"transferId\":")
      append(jsonString(transferId))
      append('}')
    }
    return body.toByteArray(StandardCharsets.UTF_8)
  }

  fun canonicalCompleteBody(files: List<V3CompletionFile>): ByteArray {
    require(files.isNotEmpty()) { "A V3 completion needs at least one file." }
    val body = buildString {
      append("{\"files\":[")
      files.forEachIndexed { index, file ->
        if (index > 0) append(',')
        require(file.contentRoot.matches(Regex("^[a-f0-9]{64}$"))) { "Invalid V3 content root." }
        append("{\"contentRoot\":")
        append(jsonString(file.contentRoot))
        append(",\"itemId\":")
        append(jsonString(file.itemId))
        append('}')
      }
      append("]}")
    }
    return body.toByteArray(StandardCharsets.UTF_8)
  }

  fun chunkDigestPagePath(transferId: String, itemId: String, offset: Int, limit: Int): String {
    require(isIdentifier(transferId) && isIdentifier(itemId)) { "Invalid V3 transfer item path." }
    require(offset >= 0 && limit in 1..1000) { "Invalid V3 chunk digest page." }
    return "/v3/transfers/$transferId/items/$itemId/chunk-digests?offset=$offset&limit=$limit"
  }

  fun contentRoot(fileSizeBytes: Long, chunkSizeBytes: Int, chunks: List<V3ChunkDigest>): String {
    require(fileSizeBytes >= 0) { "Invalid V3 file size." }
    require(chunkSizeBytes in MIN_CHUNK_BYTES..MAX_CHUNK_BYTES) { "Invalid V3 chunk size." }
    val expectedCount = chunkCount(fileSizeBytes, chunkSizeBytes)
    require(chunks.size == expectedCount) { "Incomplete V3 chunk digest list." }

    val root = MessageDigest.getInstance("SHA-256")
    root.update(rootPrefix)
    root.update(unsignedLongBytes(fileSizeBytes))
    root.update(unsignedIntBytes(chunkSizeBytes.toLong()))
    chunks.forEachIndexed { expectedIndex, chunk ->
      require(chunk.index == expectedIndex) { "V3 chunk digests must be ordered." }
      val expectedLength = expectedChunkLength(fileSizeBytes, chunkSizeBytes, expectedIndex)
      require(chunk.length == expectedLength) { "Invalid V3 chunk digest length." }
      require(chunk.sha256.size == 32) { "Invalid V3 chunk digest." }

      val leaf = MessageDigest.getInstance("SHA-256")
      leaf.update(leafPrefix)
      leaf.update(unsignedLongBytes(chunk.index.toLong()))
      leaf.update(unsignedLongBytes(chunk.length.toLong()))
      leaf.update(chunk.sha256)
      root.update(leaf.digest())
    }
    return root.digest().toV3LowerHex()
  }

  fun chunkCount(fileSizeBytes: Long, chunkSizeBytes: Int): Int {
    require(fileSizeBytes >= 0) { "Invalid V3 file size." }
    require(chunkSizeBytes > 0) { "Invalid V3 chunk size." }
    val count = fileSizeBytes / chunkSizeBytes + if (fileSizeBytes % chunkSizeBytes == 0L) 0 else 1
    require(count <= Int.MAX_VALUE) { "Too many V3 chunks." }
    return count.toInt()
  }

  fun expectedChunkLength(fileSizeBytes: Long, chunkSizeBytes: Int, chunkIndex: Int): Int {
    require(chunkIndex >= 0) { "Invalid V3 chunk index." }
    val offset = chunkIndex.toLong() * chunkSizeBytes
    require(offset < fileSizeBytes) { "Invalid V3 chunk index." }
    return minOf(chunkSizeBytes.toLong(), fileSizeBytes - offset).toInt()
  }

  fun sha256(value: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(value)

  fun decodeHex(value: String): ByteArray {
    require(value.matches(Regex("^[a-fA-F0-9]+$")) && value.length % 2 == 0) { "Invalid hexadecimal value." }
    return ByteArray(value.length / 2) { index ->
      value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
    }
  }

  private fun unsignedLongBytes(value: Long): ByteArray {
    require(value >= 0) { "Unsigned integer cannot be negative." }
    return ByteBuffer.allocate(8).order(ByteOrder.BIG_ENDIAN).putLong(value).array()
  }

  private fun unsignedIntBytes(value: Long): ByteArray {
    require(value in 0..0xffff_ffffL) { "Invalid unsigned 32-bit integer." }
    return ByteBuffer.allocate(4).order(ByteOrder.BIG_ENDIAN).putInt(value.toInt()).array()
  }

  // This matches JSON.stringify for the V3 config strings, including valid
  // Unicode pairs and escaped lone UTF-16 surrogates.
  private fun jsonString(value: String): String {
    val result = StringBuilder(value.length + 2)
    result.append('"')
    var index = 0
    while (index < value.length) {
      val character = value[index]
      when (character) {
        '"' -> result.append("\\\"")
        '\\' -> result.append("\\\\")
        '\b' -> result.append("\\b")
        '\u000c' -> result.append("\\f")
        '\n' -> result.append("\\n")
        '\r' -> result.append("\\r")
        '\t' -> result.append("\\t")
        else -> {
          when {
            character.code <= 0x1f -> appendJsonCodeUnit(result, character.code)
            Character.isHighSurrogate(character) -> {
              if (index + 1 < value.length && Character.isLowSurrogate(value[index + 1])) {
                result.append(character)
                result.append(value[index + 1])
                index += 1
              } else {
                appendJsonCodeUnit(result, character.code)
              }
            }
            Character.isLowSurrogate(character) -> appendJsonCodeUnit(result, character.code)
            else -> result.append(character)
          }
        }
      }
      index += 1
    }
    result.append('"')
    return result.toString()
  }

  private fun appendJsonCodeUnit(output: StringBuilder, codeUnit: Int) {
    output.append("\\u")
    output.append("0123456789abcdef"[(codeUnit ushr 12) and 0x0f])
    output.append("0123456789abcdef"[(codeUnit ushr 8) and 0x0f])
    output.append("0123456789abcdef"[(codeUnit ushr 4) and 0x0f])
    output.append("0123456789abcdef"[codeUnit and 0x0f])
  }

  private fun isIdentifier(value: String) = value.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"))
}

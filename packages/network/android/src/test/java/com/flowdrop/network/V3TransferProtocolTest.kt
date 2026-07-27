package com.flowdrop.network

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.fail
import org.junit.Test
import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest

class V3TransferProtocolTest {
  @Test
  fun contentRootMatchesNodeZeroByteAndMultiChunkVectors() {
    val chunkSizeBytes = 1024 * 1024
    assertEquals(
      "3904664ae64537a1ea22c9c6d304693523dc9bfd85ecc39f686b014e3f97b416",
      V3TransferProtocol.contentRoot(0, chunkSizeBytes, emptyList())
    )

    val chunks = listOf(
      V3ChunkDigest(0, chunkSizeBytes, V3TransferProtocol.sha256("abc".toByteArray(UTF_8))),
      V3ChunkDigest(1, 2, V3TransferProtocol.sha256("de".toByteArray(UTF_8)))
    )
    assertEquals(
      "54e545b75d2ade3ad8b431e80bb7e62ddd30d08e34b3431439dfe98353600ad6",
      V3TransferProtocol.contentRoot(chunkSizeBytes.toLong() + 2, chunkSizeBytes, chunks)
    )
  }

  @Test
  fun completeBodyAndChunkDigestPathStayCanonical() {
    val root = "0".repeat(64)
    assertEquals(
      "{\"files\":[{\"contentRoot\":\"$root\",\"itemId\":\"item-001\"}]}",
      String(V3TransferProtocol.canonicalCompleteBody(listOf(V3CompletionFile(root, "item-001"))), UTF_8)
    )
    assertEquals(
      "/v3/transfers/transfer-001/items/item-001/chunk-digests?offset=0&limit=1000",
      V3TransferProtocol.chunkDigestPagePath("transfer-001", "item-001", 0, 1000)
    )
    val target = V3TransferProtocol.chunkDigestPagePath("transfer-001", "item-001", 0, 1000)
    val url = v3HttpUrl("127.0.0.1", 8787, target)
    assertEquals(target, url.encodedPath + "?" + url.encodedQuery)

    try {
      V3TransferProtocol.canonicalCompleteBody(listOf(V3CompletionFile(root.uppercase(), "item-001")))
      fail("Uppercase content roots must be rejected before signing a request.")
    } catch (_: IllegalArgumentException) {
      // Expected: the wire form is strictly lowercase hexadecimal.
    }
  }

  @Test
  fun canonicalCreateBodyMatchesSharedNodeVectorBytes() {
    val fixture = loadFixture()
    val create = findCase(fixture, "create")
    val expectedBody = create.getString("body")
    val request = JSONObject(expectedBody)
    val itemValues = request.getJSONArray("items")
    val items = List(itemValues.length()) { index ->
      val item = itemValues.getJSONObject(index)
      V3CreateItem(
        itemId = item.getString("itemId"),
        mimeType = item.getString("mimeType"),
        name = item.getString("name"),
        sizeBytes = item.getLong("sizeBytes")
      )
    }

    val actualBody = V3TransferProtocol.canonicalCreateBody(
      transferId = request.getString("transferId"),
      sourceDeviceId = request.getString("sourceDeviceId"),
      chunkSizeBytes = request.getInt("chunkSizeBytes"),
      items = items
    )

    assertEquals(expectedBody, String(actualBody, UTF_8))
    assertArrayEquals(expectedBody.toByteArray(UTF_8), actualBody)
  }

  @Test
  fun canonicalCreateBodyEscapesControlCharactersWithoutChangingFieldOrder() {
    val item = V3CreateItem(
      itemId = "item-001",
      mimeType = "application/octet-stream",
      name = "quote\" slash\\ nul\u0000 unit\u001f line\n emoji\uD83D\uDE00 high\uD800 low\uDC00",
      sizeBytes = 0
    )
    val body = V3TransferProtocol.canonicalCreateBody(
      transferId = "transfer-001",
      sourceDeviceId = "source-001",
      chunkSizeBytes = 1024 * 1024,
      items = listOf(item)
    )
    assertEquals(
      "{\"chunkSizeBytes\":1048576,\"items\":[{\"itemId\":\"item-001\",\"mimeType\":\"application/octet-stream\",\"name\":\"quote\\\" slash\\\\ nul\\u0000 unit\\u001f line\\n emoji😀 high\\ud800 low\\udc00\",\"sizeBytes\":0}],\"protocol\":3,\"sourceDeviceId\":\"source-001\",\"transferId\":\"transfer-001\"}",
      String(body, UTF_8)
    )
  }

  @Test
  fun sharedHmacVectorsMatchKotlinImplementation() {
    val fixture = loadFixture()
    assertEquals("HMAC-SHA256", fixture.getString("algorithm"))
    assertEquals("UTF-8", fixture.getString("encoding"))
    assertEquals("full-request-target-including-query", fixture.getString("pathSemantics"))

    val queryOrder = fixture.getJSONArray("chunkDigestsQueryOrder")
    assertEquals("offset", queryOrder.getString(0))
    assertEquals("limit", queryOrder.getString(1))

    val secretHex = fixture.getString("secretHex")
    val timestamp = fixture.getString("timestamp")
    val nonce = fixture.getString("nonce")
    val cases = fixture.getJSONArray("cases")

    for (index in 0 until cases.length()) {
      val vector = cases.getJSONObject(index)
      val path = vector.getString("path")
      if (vector.getString("name") == "chunk-digests-page-request-target") {
        assertEquals(
          "/v3/transfers/00000000-0000-4000-8000-000000000001/items/00000000-0000-4000-8000-000000000002/chunk-digests?offset=0&limit=1000",
          path
        )
      }

      val body = vector.getString("body").toByteArray(UTF_8)
      val bodySha256 = sha256Hex(body)
      assertEquals(vector.getString("bodySha256"), bodySha256)

      val signature = V3TransferProtocol.requestSignature(
        secretHex = secretHex,
        method = vector.getString("method"),
        path = path,
        timestamp = timestamp,
        nonce = nonce,
        body = body
      )
      assertEquals(vector.getString("signature"), signature)
    }
  }

  private fun loadFixture(): JSONObject {
    val stream = javaClass.classLoader?.getResourceAsStream("v3-hmac-vectors.json")
    assertNotNull("V3 HMAC fixture must be available to JVM tests", stream)
    return stream!!.use { JSONObject(String(it.readBytes(), UTF_8)) }
  }

  private fun findCase(fixture: JSONObject, name: String): JSONObject {
    val cases = fixture.getJSONArray("cases")
    for (index in 0 until cases.length()) {
      val vector = cases.getJSONObject(index)
      if (vector.getString("name") == name) return vector
    }
    throw AssertionError("Missing V3 fixture case: $name")
  }

  private fun sha256Hex(bytes: ByteArray): String = lowerHex(
    MessageDigest.getInstance("SHA-256").digest(bytes)
  )

  private fun lowerHex(bytes: ByteArray): String {
    val digits = "0123456789abcdef"
    return buildString(bytes.size * 2) {
      for (byte in bytes) {
        val value = byte.toInt() and 0xff
        append(digits[value ushr 4])
        append(digits[value and 0x0f])
      }
    }
  }
}

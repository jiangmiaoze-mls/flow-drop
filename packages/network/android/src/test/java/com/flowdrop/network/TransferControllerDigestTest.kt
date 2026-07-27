package com.flowdrop.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

class TransferControllerDigestTest {
  @Test
  fun persistedDigestMetadataAcceptsOnlyLowercaseSha256() {
    val config = NativeTransferConfig.fromMap(baseConfig(
      listOf(
        mapOf(
          "confirmedRevision" to 7L,
          "index" to 0,
          "itemId" to "item-001",
          "length" to 1_048_576,
          "sha256" to "a".repeat(64)
        )
      )
    ))

    assertEquals(1, config.persistedChunkDigests.size)
    assertEquals(7L, requireNotNull(config.persistedChunkDigests.single().confirmedRevision))

    try {
      NativeTransferConfig.fromMap(baseConfig(listOf(
        mapOf(
          "index" to 0,
          "itemId" to "item-001",
          "length" to 1_048_576,
          "sha256" to "A".repeat(64)
        )
      )))
      fail("Uppercase persisted SHA-256 must be rejected.")
    } catch (_: IllegalArgumentException) {
      // Expected: the bridge and stored form are lowercase hexadecimal only.
    }
  }

  @Test
  fun duplicatePersistedDigestIdentityIsRejected() {
    val digest = mapOf(
      "index" to 0,
      "itemId" to "item-001",
      "length" to 1_048_576,
      "sha256" to "b".repeat(64)
    )
    try {
      NativeTransferConfig.fromMap(baseConfig(listOf(digest, digest)))
      fail("A persisted digest identity must be unique.")
    } catch (_: IllegalArgumentException) {
      // Expected.
    }
  }

  @Test
  fun mismatchDetailsContainBothSidesAndChunkIdentity() {
    val local = V3ChunkDigest(3, 128, ByteArray(32) { 0x11.toByte() })
    val agent = V3ChunkDigest(3, 128, ByteArray(32) { 0x22.toByte() })
    val details = requireNotNull(chunkDigestMismatchDetails("item-001", local, agent))

    assertEquals("item-001", details["itemId"])
    assertEquals(3, details["index"])
    assertEquals("11".repeat(32), details["localSha256"])
    assertEquals("22".repeat(32), details["agentSha256"])
    assertEquals(128, details["localLength"])
    assertEquals(128, details["agentLength"])
    assertNull(chunkDigestMismatchDetails("item-001", local, local))
  }

  private fun baseConfig(persistedChunkDigests: List<Map<String, Any>>): Map<String, Any> = mapOf(
    "initialChunkSizeBytes" to 1_048_576,
    "items" to listOf(mapOf(
      "itemId" to "item-001",
      "mimeType" to "application/octet-stream",
      "name" to "example.bin",
      "sizeBytes" to 1_048_576L,
      "sourceUri" to "content://flowdrop/example"
    )),
    "peerAddress" to "192.168.1.2",
    "peerControlPort" to 8787,
    "persistedChunkDigests" to persistedChunkDigests,
    "recovering" to true,
    "sourceDeviceId" to "source-001",
    "transferId" to "transfer-001",
    "transferSecretHex" to "0".repeat(64)
  )
}

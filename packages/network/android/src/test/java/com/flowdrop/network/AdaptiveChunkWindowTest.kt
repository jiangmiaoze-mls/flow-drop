package com.flowdrop.network

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AdaptiveChunkWindowTest {
  @Test
  fun fourDurableAcksGrowTheWindowUpToTheCapabilityLimit() = runBlocking {
    val window = AdaptiveChunkWindow(3)
    repeat(4) { window.onDurableAcknowledgement() }

    window.acquire()
    window.acquire()
    window.acquire()
    val blocked = async(start = CoroutineStart.UNDISPATCHED) { window.acquire() }
    delay(75)
    assertFalse(blocked.isCompleted)

    window.release()
    withTimeout(500) { blocked.await() }
    repeat(3) { window.release() }
  }

  @Test
  fun memoryCeilingPreventsAckGrowthAfterLowMemory() = runBlocking {
    val window = AdaptiveChunkWindow(2)
    window.shrinkForMemoryPressure()
    repeat(8) { window.onDurableAcknowledgement() }

    window.acquire()
    val blocked = async(start = CoroutineStart.UNDISPATCHED) { window.acquire() }
    delay(75)
    assertFalse(blocked.isCompleted)

    window.release()
    withTimeout(500) { blocked.await() }
    window.release()
  }

  @Test
  fun criticalMemoryPressureReducesAnExpandedWindowToOne() = runBlocking {
    val window = AdaptiveChunkWindow(4)
    repeat(8) { window.onDurableAcknowledgement() }
    window.shrinkForMemoryPressure()

    window.acquire()
    val blocked = async(start = CoroutineStart.UNDISPATCHED) { window.acquire() }
    delay(75)
    assertFalse(blocked.isCompleted)

    window.release()
    withTimeout(500) { blocked.await() }
    window.release()
  }

  @Test
  fun initialMemoryCeilingRestrictsNewWindowBeforeItsFirstAck() = runBlocking {
    val window = AdaptiveChunkWindow(4, initialMemoryCeiling = 1)
    repeat(8) { window.onDurableAcknowledgement() }

    window.acquire()
    val blocked = async(start = CoroutineStart.UNDISPATCHED) { window.acquire() }
    delay(75)
    assertFalse(blocked.isCompleted)

    window.release()
    withTimeout(500) { blocked.await() }
    window.release()
  }

  @Test
  fun shrinkWithInflightRequestsWaitsForExcessPermitsToDrain() = runBlocking {
    val window = AdaptiveChunkWindow(2)
    window.acquire()
    window.acquire()
    window.shrinkForMemoryPressure()

    val blocked = async(start = CoroutineStart.UNDISPATCHED) { window.acquire() }
    delay(75)
    assertFalse(blocked.isCompleted)

    window.release()
    delay(75)
    assertFalse(blocked.isCompleted)

    window.release()
    withTimeout(500) { blocked.await() }
    window.release()
  }

  @Test
  fun cancelledWaiterDoesNotConsumeTheNextPermit() = runBlocking {
    val window = AdaptiveChunkWindow(1)
    window.acquire()
    val waiter = async(start = CoroutineStart.UNDISPATCHED) { window.acquire() }
    delay(75)
    assertFalse(waiter.isCompleted)
    waiter.cancelAndJoin()

    window.release()
    withTimeout(500) { window.acquire() }
    window.release()
    assertTrue(waiter.isCancelled)
  }
}

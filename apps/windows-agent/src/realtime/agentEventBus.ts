import {randomUUID} from 'node:crypto'

import type {AgentEvent} from '@flowdrop/types'


const MAX_EVENT_HISTORY = 256

export class AgentEventBus {
  private readonly events: AgentEvent[] = []
  private readonly listeners = new Set<(event: AgentEvent) => void>()

  getEventsAfter(eventId?: string): AgentEvent[] {
    if (!eventId) return [...this.events]

    const eventIndex = this.events.findIndex((event) => event.eventId === eventId)
    return eventIndex === -1 ? [...this.events] : this.events.slice(eventIndex + 1)
  }

  publish(event: Omit<AgentEvent, 'eventId' | 'occurredAt'>): AgentEvent {
    const publishedEvent: AgentEvent = {
      ...event,
      eventId: randomUUID(),
      occurredAt: Date.now()
    }
    this.events.push(publishedEvent)
    if (this.events.length > MAX_EVENT_HISTORY) this.events.shift()

    for (const listener of this.listeners) listener(publishedEvent)
    return publishedEvent
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

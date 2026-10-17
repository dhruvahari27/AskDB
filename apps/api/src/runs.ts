import type { RunEvent } from '@askdb/shared';

export type IndexedEvent = RunEvent & { i: number };

export interface RunEntry {
  id: string;
  events: IndexedEvent[];
  subscribers: Set<(e: IndexedEvent) => void>;
  /** true once the current segment (start, or one resume) has emitted `done` */
  segmentDone: boolean;
  /** index of the first event of the current segment (a start, or one resume after a clarification) */
  segmentStart: number;
  touchedAt: number;
}

/**
 * Keeps each run's events in memory so a browser can attach to the stream late or reconnect and catch up
 * (`?after=N`). Persistent state lives in Postgres; this is only the live feed.
 */
export class RunManager {
  private entries = new Map<string, RunEntry>();
  private sweeper: NodeJS.Timeout;

  constructor(private ttlMs = 30 * 60_000) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  get(id: string): RunEntry | undefined {
    return this.entries.get(id);
  }

  open(id: string): RunEntry {
    let e = this.entries.get(id);
    if (!e) {
      e = { id, events: [], subscribers: new Set(), segmentDone: false, segmentStart: 0, touchedAt: Date.now() };
      this.entries.set(id, e);
    }
    e.segmentDone = false;
    e.segmentStart = e.events.length;
    e.touchedAt = Date.now();
    return e;
  }

  push(id: string, event: RunEvent): void {
    const e = this.entries.get(id);
    if (!e) return;
    const indexed = { ...event, i: e.events.length } as IndexedEvent;
    e.events.push(indexed);
    e.touchedAt = Date.now();
    if (event.type === 'done') e.segmentDone = true;
    for (const s of e.subscribers) s(indexed);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, e] of this.entries) {
      if (e.subscribers.size === 0 && now - e.touchedAt > this.ttlMs) this.entries.delete(id);
    }
  }

  close(): void {
    clearInterval(this.sweeper);
  }
}

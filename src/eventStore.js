import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

// 追加式事件存储：事件一旦写入不允许原地改写，业务更正只能追加后继事件。
// 每个聚合的版本号由存储方统一分配，并发写入时版本冲突会被拒绝。
export class EventStore {
  #journalPath;
  #events = [];
  #versions = new Map();

  constructor({ journalPath = null } = {}) {
    this.#journalPath = journalPath;
  }

  static async open({ journalPath = null } = {}) {
    const store = new EventStore({ journalPath });
    if (journalPath && existsSync(journalPath)) {
      const text = await readFile(journalPath, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        store.#apply(JSON.parse(line));
      }
    }
    return store;
  }

  #apply(event) {
    this.#events.push(event);
    this.#versions.set(event.aggregate_id, event.version);
  }

  nextVersion(aggregateId) {
    return (this.#versions.get(aggregateId) ?? 0) + 1;
  }

  async append(event) {
    const expected = this.nextVersion(event.aggregate_id);
    if (event.version !== expected) {
      throw new Error(`版本冲突：聚合 ${event.aggregate_id} 期望版本 ${expected}，收到 ${event.version}`);
    }
    if (this.#journalPath) {
      await mkdir(path.dirname(this.#journalPath), { recursive: true });
      await appendFile(this.#journalPath, `${JSON.stringify(event)}\n`, "utf8");
    }
    this.#apply(event);
    return event;
  }

  all() {
    return [...this.#events];
  }

  forAggregate(aggregateId) {
    return this.#events.filter((event) => event.aggregate_id === aggregateId);
  }
}

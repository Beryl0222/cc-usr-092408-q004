// 持久化：单文件原子提交的事件存储。
// - events：只追加事件日志，已落盘事件的标识/发生时间/版本永不原地改写；
// - requests：请求幂等台账，request_id -> 首次执行结果，重放返回原结果；
// - outbox：等待投递的通知（核验分派、撤回通知等），崩溃后据此续投。
//
// 提交通过「写临时文件 + rename」完成，单次提交要么全部可见、要么全部不可见。

import { readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export class ConcurrencyError extends Error {
  constructor(aggregateId, expected, actual) {
    super(`聚合 ${aggregateId} 版本冲突：期望 ${expected}，实际 ${actual}`);
    this.code = "CONCURRENCY_ERROR";
    this.aggregateId = aggregateId;
  }
}

export class ReplayedRequest extends Error {
  constructor(requestId, result) {
    super(`请求 ${requestId} 为重放，返回首次结果`);
    this.code = "REPLAYED_REQUEST";
    this.result = result;
  }
}

const SCHEMA_VERSION = 1;

export class EventStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { schemaVersion: SCHEMA_VERSION, events: [], requests: {}, outbox: [] };
    this.aggregateVersions = new Map();
    this._chain = Promise.resolve();
  }

  async load() {
    if (!existsSync(this.filePath)) return this;
    const raw = await readFile(this.filePath, "utf8");
    if (!raw.trim()) return this;
    this.state = JSON.parse(raw);
    this.state.events ??= [];
    this.state.requests ??= {};
    this.state.outbox ??= [];
    this.aggregateVersions = new Map();
    for (const event of this.state.events) {
      this.aggregateVersions.set(event.aggregate_id, event.version);
    }
    return this;
  }

  get events() {
    return this.state.events;
  }

  versionOf(aggregateId) {
    return this.aggregateVersions.get(aggregateId) ?? 0;
  }

  // 串行化所有写操作；重放时直接给出首次结果，命令体不会再次执行。
  async withRequest(requestId, fn) {
    return this.#serialize(async () => {
      if (requestId && Object.hasOwn(this.state.requests, requestId)) {
        return { replayed: true, result: structuredClone(this.state.requests[requestId]) };
      }
      const { events = [], outbox = [], result = null } = await fn({
        versionOf: (id) => this.versionOf(id),
      });
      for (const event of events) {
        const expected = event.version > 0 ? event.version : null;
        const next = (this.aggregateVersions.get(event.aggregate_id) ?? 0) + 1;
        if (expected !== null && expected !== next) {
          throw new ConcurrencyError(event.aggregate_id, expected, next);
        }
        event.version = next;
        this.aggregateVersions.set(event.aggregate_id, next);
        this.state.events.push(event);
      }
      for (const message of outbox) this.state.outbox.push(message);
      if (requestId) this.state.requests[requestId] = structuredClone(result);
      await this.#persist();
      return { replayed: false, result: structuredClone(result), events, outbox };
    });
  }

  // outbox 投递状态更新（不含领域事件）。
  async updateOutbox(id, patch) {
    return this.#serialize(async () => {
      const message = this.state.outbox.find((m) => m.message_id === id);
      if (!message) return false;
      Object.assign(message, patch);
      await this.#persist();
      return true;
    });
  }

  pendingOutbox(now = Date.now()) {
    return this.state.outbox
      .filter((m) => m.status === "pending" && (m.deliver_after ?? 0) <= now)
      .map((m) => structuredClone(m));
  }

  async #persist() {
    const tmp = path.join(path.dirname(this.filePath), `.${path.basename(this.filePath)}.tmp`);
    await writeFile(tmp, JSON.stringify(this.state), "utf8");
    await rename(tmp, this.filePath);
  }

  #serialize(fn) {
    const run = this._chain.then(() => fn());
    // 链条不因单次失败而中断。
    this._chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

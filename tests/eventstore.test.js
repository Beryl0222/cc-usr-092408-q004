import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/eventStore.js";

const base = {
  event_type: "WORK_REGISTERED",
  aggregate_type: "work",
  occurred_at: "2026-09-21T09:00:00+08:00",
  summary: "测试事件",
  payload: {},
};

test("并发入库时同一聚合的版本冲突被拒绝", async () => {
  const store = await EventStore.open();
  await store.append({ ...base, event_id: "evt-1", aggregate_id: "w-1", version: 1 });
  await assert.rejects(
    () => store.append({ ...base, event_id: "evt-2", aggregate_id: "w-1", version: 1 }),
    /版本冲突/,
  );
  await store.append({ ...base, event_id: "evt-3", aggregate_id: "w-1", version: 2 });
  assert.equal(store.forAggregate("w-1").length, 2);
});

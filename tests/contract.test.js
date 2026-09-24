import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AggregateType, EventType } from "../src/events.js";
import { validateEvent, validateSubmissionRecord } from "../src/validator.js";

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("契约枚举与代码常量一致", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  const eventEnum = schema.properties.event_type.enum;
  const aggregateEnum = schema.properties.aggregate_type.enum;
  for (const type of Object.values(EventType)) {
    assert.ok(eventEnum.includes(type), `契约缺少事件类型：${type}`);
  }
  for (const type of Object.values(AggregateType)) {
    assert.ok(aggregateEnum.includes(type), `契约缺少聚合类型：${type}`);
  }
});

test("投稿记录校验能挑出坏记录", () => {
  assert.deepEqual(validateSubmissionRecord({ submission_id: "s-1", work: { work_id: "w-1", content_summary: "x" } }), []);
  assert.ok(validateSubmissionRecord({}).length > 0);
  assert.ok(validateSubmissionRecord({ submission_id: "s-1" }).length > 0);
  assert.ok(
    validateSubmissionRecord({ submission_id: "s-1", work: { work_id: "w-1", content_summary: "x", clips: [{}] } })
      .some((e) => e.includes("clip_id")),
  );
});

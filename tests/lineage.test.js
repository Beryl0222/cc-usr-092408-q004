import assert from "node:assert/strict";
import test from "node:test";

import { IntakeService } from "../src/service.js";
import { clipRecord, redactionRecord, workRecord } from "./factories.js";

test("投稿拆出作品、片段、声明、凭证、脱敏版本各自的谱系", async () => {
  const service = await IntakeService.open();
  await service.receiveBatch("req-lineage", [
    workRecord("w-1", "digest-w1"),
    clipRecord("c-1", "w-1", "digest-c1", { flags: { sensitiveGeo: true } }),
    redactionRecord("r-1", "w-1", "c-1", "digest-r1"),
    clipRecord("c-2", "w-1", "digest-r1", { replaces: "c-1" }),
  ]);
  assert.equal(service.lineageOf("w-1").kind, "work");
  assert.equal(service.lineageOf("r-1").kind, "redacted_variant");
  assert.deepEqual(service.lineageOf("r-1").parents, ["c-1"]);
  assert.deepEqual(service.lineageOf("c-2").parents, ["c-1"]);
});

test("内容摘要相同只提示关联，由编辑决定是否合并", async () => {
  const service = await IntakeService.open();
  await service.receiveBatch("req-1", [
    workRecord("w-1", "digest-same"),
    clipRecord("c-1", "w-1", "digest-c1"),
  ]);
  await service.receiveBatch("req-2", [
    workRecord("w-2", "digest-same"),
    clipRecord("c-2", "w-2", "digest-c1"),
  ]);

  const suggestions = service.associations();
  assert.equal(suggestions.length, 2);
  assert.ok(suggestions.every((suggestion) => suggestion.status === "pending"));
  // 提示关联不等于合并：实体仍然各自独立
  assert.deepEqual(service.lineageOf("w-1").mergedWith, []);

  const workSuggestion = suggestions.find((suggestion) => suggestion.entityIds.includes("w-2"));
  await service.decideMerge({ suggestionId: workSuggestion.id, merge: true, editor: "编辑甲" });
  assert.deepEqual(service.lineageOf("w-1").mergedWith, ["w-2"]);
  assert.deepEqual(service.lineageOf("w-2").mergedWith, ["w-1"]);

  const clipSuggestion = suggestions.find((suggestion) => suggestion.entityIds.includes("c-2"));
  await service.decideMerge({ suggestionId: clipSuggestion.id, merge: false, editor: "编辑甲" });
  assert.equal(service.associations().find((s) => s.id === clipSuggestion.id).status, "dismissed");
  assert.deepEqual(service.lineageOf("c-1").mergedWith, []);
});

test("合并决定幂等：重复决定返回重复结果", async () => {
  const service = await IntakeService.open();
  await service.receiveBatch("req-1", [workRecord("w-1", "digest-same")]);
  await service.receiveBatch("req-2", [workRecord("w-2", "digest-same")]);
  const [suggestion] = service.associations();
  const first = await service.decideMerge({ suggestionId: suggestion.id, merge: true, editor: "编辑甲" });
  const second = await service.decideMerge({ suggestionId: suggestion.id, merge: false, editor: "编辑乙" });
  assert.equal(first.kind, "accepted");
  assert.equal(second.kind, "duplicate");
  assert.equal(service.associations()[0].status, "merged");
});

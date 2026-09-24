import assert from "node:assert/strict";
import test from "node:test";

import { IntakeService } from "../src/service.js";
import { clipRecord, workRecord } from "./factories.js";

test("批量接收混有坏记录时保住其余作品", async () => {
  const service = await IntakeService.open();
  const response = await service.receiveBatch("req-batch-1", [
    workRecord("w-1", "digest-a"),
    { event_type: "WORK_REGISTERED" },
    workRecord("w-2", "digest-b"),
  ]);
  assert.deepEqual(response.accepted, ["w-1", "w-2"]);
  assert.equal(response.rejected.length, 1);
  assert.equal(response.rejected[0].index, 1);
  assert.ok(service.entity("w-1"));
  assert.ok(service.entity("w-2"));
});

test("同一请求重放返回原结果，且不产生新事件", async () => {
  const service = await IntakeService.open();
  const records = [workRecord("w-1", "digest-a")];
  const first = await service.receiveBatch("req-replay", records);
  const second = await service.receiveBatch("req-replay", records);
  assert.deepEqual(second, first);
  assert.equal(service.events().filter((event) => event.event_type === "WORK_REGISTERED").length, 1);
});

test("请求编号相同而内容不同则拒绝", async () => {
  const service = await IntakeService.open();
  await service.receiveBatch("req-conflict", [workRecord("w-1", "digest-a")]);
  await assert.rejects(
    () => service.receiveBatch("req-conflict", [workRecord("w-9", "digest-z")]),
    /请求编号冲突/,
  );
});

test("实体编号相同而摘要不同的记录隔离待查，原记录不被覆盖", async () => {
  const service = await IntakeService.open();
  await service.receiveBatch("req-1", [workRecord("w-1", "digest-a")]);
  const response = await service.receiveBatch("req-2", [workRecord("w-1", "digest-b")]);
  assert.deepEqual(response.quarantined, ["w-1"]);
  assert.equal(service.quarantined().length, 1);
  assert.equal(service.quarantined()[0].conflictingId, "w-1");
  assert.equal(service.entity("w-1").digest, "digest-a");
});

test("编号与摘要都相同的重复登记视为重复而非隔离", async () => {
  const service = await IntakeService.open();
  await service.receiveBatch("req-1", [workRecord("w-1", "digest-a")]);
  const response = await service.receiveBatch("req-2", [workRecord("w-1", "digest-a")]);
  assert.deepEqual(response.duplicates, ["w-1"]);
  assert.equal(service.quarantined().length, 0);
});

test("片段引用不存在的作品时按坏记录处理", async () => {
  const service = await IntakeService.open();
  const response = await service.receiveBatch("req-orphan", [
    clipRecord("c-1", "w-missing", "digest-c1"),
  ]);
  assert.equal(response.accepted.length, 0);
  assert.equal(response.rejected.length, 1);
  assert.match(response.rejected[0].errors[0], /作品不存在/);
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { IntakeService } from "../src/service.js";
import { clipRecord, consentRecord, credentialRecord, workRecord } from "./factories.js";

const PURPOSE = { purpose: "broadcast", territory: "CN" };

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "yellow-river-"));
}

test("中断后重开：未完成的授权核验继续推进", async () => {
  const dir = await tempDir();
  try {
    let service = await IntakeService.open({ dataDir: dir });
    await service.receiveBatch("req-1", [
      workRecord("w-1", "digest-w1"),
      clipRecord("c-1", "w-1", "digest-c1"),
      credentialRecord("cred-1", "w-1"),
    ]);
    assert.equal(service.pendingJobs().length, 1);
    assert.equal(service.entity("cred-1").confirmed, false);

    // 模拟中断：直接丢弃内存实例，再从磁盘重开
    service = await IntakeService.open({ dataDir: dir });
    assert.equal(service.pendingJobs().length, 1);
    await service.resume();
    assert.equal(service.entity("cred-1").confirmed, true);
    assert.equal(service.pendingJobs().length, 0);

    // 再恢复一次不会重复执行
    service = await IntakeService.open({ dataDir: dir });
    const rerun = await service.resume();
    assert.deepEqual(rerun, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("中断后重开：撤回通知继续送达，并保留处置记录", async () => {
  const dir = await tempDir();
  try {
    let service = await IntakeService.open({ dataDir: dir });
    await service.receiveBatch("req-1", [
      workRecord("w-1", "digest-w1"),
      clipRecord("c-1", "w-1", "digest-c1", { requiresConsent: true }),
      consentRecord("d-1", "w-1", ["c-1"]),
      credentialRecord("cred-1", "w-1"),
    ]);
    await service.resume();
    const publication = await service.selectPurpose({ workId: "w-1", ...PURPOSE });
    await service.withdrawConsent({ declarationId: "d-1", by: "出镜人物" });
    // 不 resume，通知任务挂起时中断
    assert.ok(service.pendingJobs().some((job) => job.type === "NOTIFY_WITHDRAWAL"));

    service = await IntakeService.open({ dataDir: dir });
    const processed = await service.resume();
    assert.equal(processed.length, 1);
    const explained = service.explainPublication(publication.id);
    assert.equal(explained.dispositions.length, 1);
    assert.ok(service.events().some((event) => event.event_type === "WITHDRAWAL_NOTIFIED"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("重放幂等结果落盘：重开后同一请求仍返回原结果", async () => {
  const dir = await tempDir();
  try {
    const records = [workRecord("w-1", "digest-a"), workRecord("w-2", "digest-b")];
    let service = await IntakeService.open({ dataDir: dir });
    const first = await service.receiveBatch("req-persist", records);

    service = await IntakeService.open({ dataDir: dir });
    const second = await service.receiveBatch("req-persist", records);
    assert.deepEqual(second, first);
    assert.equal(service.events().filter((event) => event.event_type === "WORK_REGISTERED").length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

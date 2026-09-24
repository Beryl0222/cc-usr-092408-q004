import assert from "node:assert/strict";
import test from "node:test";

import { IntakeService } from "../src/system.js";
import { clearVerifications, makeService, submission } from "./helpers.js";

test("中断后恢复：未投递的撤回通知续投，未完成核验重新列队", async () => {
  // 第一次运行：投递器对撤回通知总是失败，模拟中断。
  const { service, filePath } = await makeService({
    deliver: async (m) => {
      if (m.kind === "consent_withdrawn") throw new Error("模拟投递中断");
    },
    maxAttempts: 10,
  });
  await service.dispatch("intake_batch", {
    batch_id: "b-crash",
    records: [submission({ workId: "work-crash" })],
  });
  await clearVerifications(service, "work-crash");
  const { basis_id } = await service.dispatch("freeze_basis", { work_id: "work-crash", purpose: "web" });
  await service.dispatch("release_publication", { work_id: "work-crash", basis_id });
  await service.dispatch("withdraw_consent", { credential_id: "work-crash-lic" });

  // 撤回通知投递失败，仍留在 outbox。
  assert.ok(service.pendingOutbox().some((m) => m.kind === "consent_withdrawn"));

  // 模拟重启：同一库文件重新打开，换一个能成功的投递器。
  const delivered = [];
  const revived = await IntakeService.open({
    filePath,
    deliver: async (m) => delivered.push(m),
  });
  const report = await revived.recover();

  // 撤回通知续投成功。
  assert.ok(delivered.some((m) => m.kind === "consent_withdrawn"));
  assert.equal(revived.pendingOutbox().length, 0);

  // 另开一批含待复核片段的投稿，中断后复核任务仍在待办里。
  await revived.dispatch("intake_batch", {
    batch_id: "b-crash-2",
    records: [submission({ workId: "work-crash-2", clips: [{ clip_id: "wc2-c1", has_minor: true }] })],
  });
  const revived2 = await IntakeService.open({ filePath, deliver: async () => {} });
  const report2 = await revived2.recover();
  assert.ok(
    report2.pending_verifications.some(
      (v) => v.work_id === "work-crash-2" && v.kind === "minor" && v.assignee_role === "minor_protection_reviewer",
    ),
  );
  void report;
});

test("重放的请求在重启后仍返回原结果", async () => {
  const { service, filePath } = await makeService();
  const payload = { batch_id: "b-durable", records: [submission({ workId: "work-durable" })] };
  const first = await service.dispatch("intake_batch", payload, { requestId: "req-durable" });

  const revived = await IntakeService.open({ filePath, deliver: async () => {} });
  const second = await revived.dispatch("intake_batch", payload, { requestId: "req-durable" });
  assert.deepEqual(second, first);
  // 事件没有翻倍。
  assert.equal([...revived.model.works.keys()].filter((id) => id === "work-durable").length, 1);
});

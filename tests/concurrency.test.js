import assert from "node:assert/strict";
import test from "node:test";

import { clearVerifications, makeService, submission } from "./helpers.js";

test("并发入库：批次串行落盘，事件版本连续", async () => {
  const { service, cleanup } = await makeService();
  try {
    const batches = Array.from({ length: 6 }, (_, i) =>
      service.dispatch("intake_batch", {
        batch_id: `b-par-${i}`,
        records: [submission({ workId: `work-par-${i}` })],
      }),
    );
    const results = await Promise.all(batches);
    assert.equal(results.filter((r) => r.accepted.length === 1).length, 6);

    // 每个投稿聚合的版本从 1 开始连续编号。
    const byAggregate = new Map();
    for (const e of service.events) {
      const list = byAggregate.get(e.aggregate_id) ?? [];
      list.push(e.version);
      byAggregate.set(e.aggregate_id, list);
    }
    for (const [, versions] of byAggregate) {
      versions.sort((a, b) => a - b);
      versions.forEach((v, i) => assert.equal(v, i + 1));
    }
  } finally {
    await cleanup();
  }
});

test("并发冻结与迟到授权：已冻结依据保持原样", async () => {
  const { service, cleanup } = await makeService();
  try {
    await service.dispatch("intake_batch", {
      batch_id: "b-cf",
      records: [submission({ workId: "work-cf" })],
    });
    await clearVerifications(service, "work-cf");

    // 并发：两次冻结 + 一次补交授权同时到达。
    const [f1, f2] = await Promise.all([
      service.dispatch("freeze_basis", { work_id: "work-cf", purpose: "web" }),
      service.dispatch("freeze_basis", { work_id: "work-cf", purpose: "web" }),
      service.dispatch("add_credential", {
        work_id: "work-cf",
        credential: { credential_id: "cf-late", credential_type: "license", scope: ["web"] },
      }),
    ]);
    assert.notEqual(f1.basis_id, f2.basis_id);
    // 两份依据都只含冻结时有效的凭证集合（迟到授权是否进入取决于串行顺序，但绝不变更已写事件）。
    const s1 = service.model.bases.get(f1.basis_id).snapshot;
    const s2 = service.model.bases.get(f2.basis_id).snapshot;
    assert.ok(s1.credentials.length >= 1 && s2.credentials.length >= 1);
    const total = s1.credentials.length + s2.credentials.length;
    assert.ok(total === 2 || total === 3); // 串行顺序决定 late 凭证是否出现在第二份快照
  } finally {
    await cleanup();
  }
});

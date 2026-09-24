import assert from "node:assert/strict";
import test from "node:test";

import { clearVerifications, makeService, submission } from "./helpers.js";

test("投稿拆出作品/片段/声明/凭证/脱敏版本各自谱系", async () => {
  const { service, cleanup } = await makeService();
  try {
    const record = submission({
      workId: "work-lineage",
      clips: [
        { clip_id: "wl-c1", has_minor: true },
        { clip_id: "wl-c2", has_sensitive_geo: true },
      ],
      variants: [{ variant_id: "wl-v1", source_clip_id: "wl-c2", redaction: "geo_blur" }],
    });
    const result = await service.dispatch("intake_batch", { batch_id: "b-1", records: [record] });
    assert.equal(result.accepted.length, 1);

    const lineage = service.workLineage("work-lineage");
    assert.equal(lineage.work.work_id, "work-lineage");
    assert.deepEqual(
      lineage.clips.map((c) => c.clip_id).sort(),
      ["wl-c1", "wl-c2"],
    );
    assert.equal(lineage.declarations.length, 1);
    assert.equal(lineage.credentials.length, 1);
    assert.equal(lineage.variants.length, 1);
    assert.equal(lineage.variants[0].source_clip_id, "wl-c2");

    // 未成年人与敏感地理位置分流到不同角色复核。
    const roles = [...service.model.verifications.values()]
      .filter((v) => v.work_id === "work-lineage")
      .map((v) => [v.clip_id, v.kind, v.assignee_role]);
    assert.ok(roles.some(([, kind, role]) => kind === "minor" && role === "minor_protection_reviewer"));
    assert.ok(roles.some(([, kind, role]) => kind === "sensitive_geography" && role === "geo_compliance_reviewer"));
  } finally {
    await cleanup();
  }
});

test("内容摘要相同只提示关联，由编辑决定是否合并", async () => {
  const { service, cleanup } = await makeService();
  try {
    const sameSummary = "同一段黄河航拍素材";
    await service.dispatch("intake_batch", {
      batch_id: "b-1",
      records: [submission({ workId: "work-a", content_summary: sameSummary })],
    });
    const result = await service.dispatch("intake_batch", {
      batch_id: "b-2",
      records: [submission({ workId: "work-b", content_summary: sameSummary })],
    });
    // 只提示关联，不自动合并。
    assert.equal(result.associated.length, 1);
    assert.equal(result.associated[0].other_work_id, "work-a");
    assert.equal(service.model.works.get("work-a").status, "registered");
    assert.equal(service.model.works.get("work-b").status, "registered");
    assert.deepEqual(service.workLineage("work-b").related, ["work-a"]);

    // 编辑决定合并后，谱系归并到目标作品。
    await service.dispatch("merge_works", { work_id: "work-a", merged_work_id: "work-b", decided_by: "editor-1" });
    assert.equal(service.model.works.get("work-b").status, "merged");
    assert.equal(service.model.works.get("work-b").merged_into, "work-a");
    assert.ok(service.model.works.get("work-a").clip_ids.includes("work-b-c1"));
  } finally {
    await cleanup();
  }
});

test("编号相同而摘要不同则隔离待查", async () => {
  const { service, cleanup } = await makeService();
  try {
    await service.dispatch("intake_batch", {
      batch_id: "b-1",
      records: [submission({ workId: "work-x", content_summary: "原始版本" })],
    });
    const result = await service.dispatch("intake_batch", {
      batch_id: "b-2",
      records: [submission({ workId: "work-x", content_summary: "完全不同的内容" })],
    });
    assert.equal(result.quarantined.length, 1);
    assert.equal(service.model.works.get("work-x").status, "quarantined");
    assert.equal(service.model.quarantine.get("work-x").reason, "digest_mismatch");

    // 隔离期间不能冻结依据；人工解除后恢复。
    await clearVerifications(service, "work-x");
    await assert.rejects(
      service.dispatch("freeze_basis", { work_id: "work-x", purpose: "web" }),
      /quarantined/,
    );
    await service.dispatch("resolve_quarantine", { work_id: "work-x", decided_by: "editor-1" });
    assert.equal(service.model.works.get("work-x").status, "registered");
  } finally {
    await cleanup();
  }
});

test("批量接收混有坏记录时保住其余作品", async () => {
  const { service, cleanup } = await makeService();
  try {
    const result = await service.dispatch("intake_batch", {
      batch_id: "b-mixed",
      records: [
        submission({ workId: "good-1" }),
        { submission_id: "bad-1" }, // 缺 work
        submission({ workId: "good-2" }),
        { submission_id: "bad-2", work: { work_id: "w-no-summary" } }, // 缺摘要
      ],
    });
    assert.deepEqual(
      result.accepted.map((a) => a.work_id).sort(),
      ["good-1", "good-2"],
    );
    assert.equal(result.rejected.length, 2);
    assert.ok(service.model.works.has("good-1"));
    assert.ok(service.model.works.has("good-2"));
    assert.ok(!service.model.works.has("w-no-summary"));
  } finally {
    await cleanup();
  }
});

test("同一请求重放返回原结果，不产生重复事件", async () => {
  const { service, cleanup } = await makeService();
  try {
    const payload = { batch_id: "b-replay", records: [submission({ workId: "work-replay" })] };
    const first = await service.dispatch("intake_batch", payload, { requestId: "req-1" });
    const eventCount = service.model.works.get("work-replay").events;

    const second = await service.dispatch("intake_batch", payload, { requestId: "req-1" });
    assert.deepEqual(second, first);
    // 事件日志没有增长。
    assert.equal(service.model.works.get("work-replay").events, eventCount);
    const replays = service.model.submissions.size;
    assert.equal(replays, 1);
  } finally {
    await cleanup();
  }
});

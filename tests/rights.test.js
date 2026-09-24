import assert from "node:assert/strict";
import test from "node:test";

import { clearVerifications, makeService, submission } from "./helpers.js";

async function readyWork(service, workId, overrides = {}) {
  await service.dispatch("intake_batch", {
    batch_id: `b-${workId}`,
    records: [submission({ workId, ...overrides })],
  });
  await clearVerifications(service, workId);
}

test("冻结发布依据：当时有效的版权范围/同意/地域限制被打包", async () => {
  const { service, cleanup } = await makeService();
  try {
    await readyWork(service, "work-f", {
      clips: [
        { clip_id: "wf-c1", consent_scope: "granted" },
        { clip_id: "wf-c2", has_sensitive_geo: true, consent_scope: "granted" },
      ],
    });
    const { basis_id } = await service.dispatch("freeze_basis", { work_id: "work-f", purpose: "web" });
    const basis = service.model.bases.get(basis_id);
    assert.equal(basis.purpose, "web");
    assert.equal(basis.snapshot.credentials.length, 1);
    assert.deepEqual(basis.snapshot.geo_restricted_clips, ["wf-c2"]);
    assert.deepEqual(
      basis.snapshot.consent.map((c) => c.clip_id).sort(),
      ["wf-c1", "wf-c2"],
    );
  } finally {
    await cleanup();
  }
});

test("迟到授权与并发入库不改变已冻结的发布依据", async () => {
  const { service, cleanup } = await makeService();
  try {
    await readyWork(service, "work-late");
    const { basis_id } = await service.dispatch("freeze_basis", { work_id: "work-late", purpose: "web" });
    const frozen = structuredClone(service.model.bases.get(basis_id).snapshot);

    // 迟到授权：补交新凭证。
    await service.dispatch("add_credential", {
      work_id: "work-late",
      credential: {
        credential_id: "late-lic",
        credential_type: "license",
        scope: ["web", "tv"],
        valid_until: "2028-01-01T00:00:00+08:00",
      },
    });
    // 并发入库：另一批投稿同时进来。
    await service.dispatch("intake_batch", {
      batch_id: "b-concurrent",
      records: [submission({ workId: "work-other" })],
    });

    const after = service.model.bases.get(basis_id).snapshot;
    assert.deepEqual(after, frozen);
    assert.equal(after.credentials.length, 1); // 仍是冻结时那一份
  } finally {
    await cleanup();
  }
});

test("撤回只阻止之后的新使用，已发生的合规发布追加处置记录", async () => {
  const { service, delivered, cleanup } = await makeService();
  try {
    await readyWork(service, "work-w");
    const { basis_id } = await service.dispatch("freeze_basis", { work_id: "work-w", purpose: "web" });
    const { publication_id } = await service.dispatch("release_publication", {
      work_id: "work-w",
      basis_id,
    });

    // 撤回人物肖像同意。
    const result = await service.dispatch("withdraw_consent", { credential_id: "work-w-lic" });
    assert.deepEqual(result.affected_publications, [publication_id]);

    // 已发生的发布：追加处置记录，且发布本身仍有效。
    const pub = service.model.publications.get(publication_id);
    assert.equal(pub.post_actions.length, 1);
    assert.equal(pub.post_actions[0].action, "consent_withdrawn_notice");
    assert.ok(delivered.some((m) => m.kind === "consent_withdrawn"));

    // 之后的新使用被阻止。
    await assert.rejects(
      service.dispatch("release_publication", { work_id: "work-w", basis_id }),
      /撤回/,
    );
  } finally {
    await cleanup();
  }
});

test("复核未完成不能冻结；用途不被授权覆盖时不能冻结", async () => {
  const { service, cleanup } = await makeService();
  try {
    await service.dispatch("intake_batch", {
      batch_id: "b-pending",
      records: [submission({ workId: "work-pending" })],
    });
    await assert.rejects(
      service.dispatch("freeze_basis", { work_id: "work-pending", purpose: "web" }),
      /复核未完成/,
    );
    await clearVerifications(service, "work-pending");
    await assert.rejects(
      service.dispatch("freeze_basis", { work_id: "work-pending", purpose: "cinema" }),
      /没有有效权利凭证/,
    );
  } finally {
    await cleanup();
  }
});

test("片段替换留痕，脱敏版本独立登记", async () => {
  const { service, cleanup } = await makeService();
  try {
    await readyWork(service, "work-r", {
      clips: [{ clip_id: "wr-old", has_sensitive_geo: true, consent_scope: "granted" }],
    });
    await service.dispatch("replace_clip", {
      work_id: "work-r",
      old_clip_id: "wr-old",
      new_clip: { clip_id: "wr-new", has_sensitive_geo: false, consent_scope: "granted" },
      reason: "初审后发现受限地理信息，换用脱敏素材",
    });
    const work = service.model.works.get("work-r");
    assert.deepEqual(work.clip_ids, ["wr-new"]);
    assert.equal(work.replaced_clips.length, 1);
    assert.equal(work.replaced_clips[0].old_clip_id, "wr-old");
  } finally {
    await cleanup();
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import { clearVerifications, makeService, submission } from "./helpers.js";

test("打开成片能说明：为何获准、替换过哪些片段、哪些合作方尚未确认", async () => {
  const { service, cleanup } = await makeService();
  try {
    // 含受限地理片段的投稿，初审后替换为脱敏素材；一条凭证需合作方确认。
    await service.dispatch("intake_batch", {
      batch_id: "b-trace",
      records: [
        submission({
          workId: "work-trace",
          clips: [{ clip_id: "wt-geo", has_sensitive_geo: true, consent_scope: "granted" }],
          credentials: [
            {
              credential_id: "wt-lic",
              credential_type: "license",
              scope: ["web"],
              partner: "航拍合作方A",
            },
          ],
        }),
      ],
    });
    await service.dispatch("replace_clip", {
      work_id: "work-trace",
      old_clip_id: "wt-geo",
      new_clip: { clip_id: "wt-clean", has_sensitive_geo: false, consent_scope: "granted" },
      reason: "初审后发现受限地理信息",
    });
    await clearVerifications(service, "work-trace");
    const { basis_id } = await service.dispatch("freeze_basis", { work_id: "work-trace", purpose: "web" });
    const { publication_id } = await service.dispatch("release_publication", {
      work_id: "work-trace",
      basis_id,
    });

    const explain = service.explainPublication(publication_id);
    // 为何获准：冻结依据里的凭证与同意范围。
    assert.equal(explain.approved_because.basis_id, basis_id);
    assert.equal(explain.approved_because.credentials[0].credential_id, "wt-lic");
    // 替换过哪些片段。
    assert.deepEqual(
      explain.replaced_clips.map((r) => [r.old_clip_id, r.new_clip_id]),
      [["wt-geo", "wt-clean"]],
    );
    // 哪些合作方尚未确认。
    assert.deepEqual(explain.unconfirmed_partners, [{ credential_id: "wt-lic", partner: "航拍合作方A" }]);

    // 合作方随后确认：解释随之更新，但冻结依据本身不变。
    const frozenBefore = structuredClone(service.model.bases.get(basis_id).snapshot);
    await service.dispatch("confirm_partner", { credential_id: "wt-lic", decision: "confirmed" });
    const explain2 = service.explainPublication(publication_id);
    assert.deepEqual(explain2.unconfirmed_partners, []);
    assert.deepEqual(service.model.bases.get(basis_id).snapshot, frozenBefore);
  } finally {
    await cleanup();
  }
});

test("撤回后的成片解释包含追加的处置记录", async () => {
  const { service, cleanup } = await makeService();
  try {
    await service.dispatch("intake_batch", {
      batch_id: "b-trace2",
      records: [submission({ workId: "work-trace2" })],
    });
    await clearVerifications(service, "work-trace2");
    const { basis_id } = await service.dispatch("freeze_basis", { work_id: "work-trace2", purpose: "web" });
    const { publication_id } = await service.dispatch("release_publication", {
      work_id: "work-trace2",
      basis_id,
    });
    await service.dispatch("withdraw_consent", { credential_id: "work-trace2-lic" });

    const explain = service.explainPublication(publication_id);
    assert.equal(explain.post_publication_actions.length, 1);
    assert.match(explain.post_publication_actions[0].detail, /撤回前的合规使用/);
  } finally {
    await cleanup();
  }
});

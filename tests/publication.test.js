import assert from "node:assert/strict";
import test from "node:test";

import { IntakeService, REVIEW_ROLES } from "../src/service.js";
import { clipRecord, consentRecord, credentialRecord, serviceWithCleanWork, workRecord } from "./factories.js";

const PURPOSE = { purpose: "broadcast", territory: "CN" };

test("选择发布用途时冻结版权范围、人物同意与地域限制作为依据", async () => {
  const service = await serviceWithCleanWork();
  const publication = await service.selectPurpose({ workId: "w-1", ...PURPOSE, editor: "编辑甲" });
  assert.equal(publication.status, "published");
  const [decision] = publication.basis.decisions;
  assert.equal(decision.cleared, true);
  assert.deepEqual(decision.copyright.credentialIds, ["cred-1"]);
  assert.deepEqual(decision.consent.consentIds, ["d-1"]);
});

test("迟到授权不能改变已经冻结的发布依据", async () => {
  const service = await serviceWithCleanWork();
  const before = await service.selectPurpose({ workId: "w-1", ...PURPOSE });
  const basisBefore = JSON.stringify(before.basis);
  await service.receiveBatch("req-late", [
    credentialRecord("cred-2", "w-1", { partner: "航拍团队乙", digest: "digest-cred-2" }),
  ]);
  await service.resume();
  const explained = service.explainPublication(before.id);
  assert.equal(JSON.stringify(explained.whyApproved[0].copyright.credentialIds), JSON.stringify(["cred-1"]));
  assert.equal(JSON.stringify(before.basis), basisBefore);
});

test("撤回只阻止之后的新使用，已发布成片追加处置记录", async () => {
  const service = await serviceWithCleanWork();
  const publication = await service.selectPurpose({ workId: "w-1", ...PURPOSE });

  await service.withdrawConsent({ declarationId: "d-1", by: "出镜人物" });
  await service.resume();

  const explained = service.explainPublication(publication.id);
  assert.equal(explained.status, "published");
  assert.equal(explained.dispositions.length, 1);
  assert.equal(explained.dispositions[0].cause, "CONSENT_WITHDRAWN");
  assert.deepEqual(explained.whyApproved[0].consent.consentIds, ["d-1"]);

  const next = await service.selectPurpose({ workId: "w-1", purpose: "web", territory: "CN" });
  assert.equal(next.status, "rejected");
  assert.match(next.rejectionReasons[0], /人物同意已被撤回/);
});

test("凭证范围不覆盖所选用途或地域时拦下发布", async () => {
  const service = await serviceWithCleanWork();
  const publication = await service.selectPurpose({ workId: "w-1", purpose: "cinema", territory: "CN" });
  assert.equal(publication.status, "rejected");
  assert.match(publication.rejectionReasons[0], /授权范围不覆盖/);
});

test("授权尚未确认时合作方出现在未确认名单，且发布被拦", async () => {
  const service = await IntakeService.open();
  await service.receiveBatch("req-unconfirmed", [
    workRecord("w-1", "digest-w1"),
    clipRecord("c-1", "w-1", "digest-c1"),
    credentialRecord("cred-1", "w-1", { partner: "航拍团队丙" }),
  ]);
  // 不调用 resume：凭证保持未确认
  const publication = await service.selectPurpose({ workId: "w-1", ...PURPOSE });
  assert.equal(publication.status, "rejected");
  assert.deepEqual(service.explainPublication(publication.id).pendingPartners, ["航拍团队丙"]);
});

test("未成年人片段与敏感位置片段分别交给不同角色复核", async () => {
  const service = await IntakeService.open();
  await service.receiveBatch("req-flags", [
    workRecord("w-1", "digest-w1"),
    clipRecord("c-minor", "w-1", "digest-cm", { flags: { hasMinor: true } }),
    clipRecord("c-geo", "w-1", "digest-cg", { flags: { sensitiveGeo: true }, blockedTerritories: ["CN"] }),
  ]);
  assert.equal(service.reviewsOf("c-minor")[REVIEW_ROLES.MINOR].status, "pending");
  assert.equal(service.reviewsOf("c-geo")[REVIEW_ROLES.GEO].status, "pending");
  assert.ok(!service.reviewsOf("c-minor")[REVIEW_ROLES.GEO]);

  const blocked = await service.selectPurpose({ workId: "w-1", ...PURPOSE });
  assert.equal(blocked.status, "rejected");
  const reasons = blocked.rejectionReasons.join("\n");
  assert.match(reasons, /minor_protection/);
  assert.match(reasons, /geo_security/);

  await service.resolveReview({ clipId: "c-minor", role: REVIEW_ROLES.MINOR, approved: true, reviewer: "未成年人保护员" });
  await service.resolveReview({ clipId: "c-geo", role: REVIEW_ROLES.GEO, approved: false, reviewer: "地理安全员" });
  const stillBlocked = await service.selectPurpose({ workId: "w-1", purpose: "broadcast", territory: "US" });
  assert.equal(stillBlocked.status, "rejected");
  assert.match(stillBlocked.rejectionReasons.join("\n"), /复核未通过/);
});

test("片段替换链被记录，被替换片段不再参与发布依据", async () => {
  const service = await IntakeService.open();
  await service.receiveBatch("req-replace", [
    workRecord("w-1", "digest-w1"),
    clipRecord("c-old", "w-1", "digest-old"),
    credentialRecord("cred-1", "w-1"),
  ]);
  await service.receiveBatch("req-replace-2", [
    clipRecord("c-new", "w-1", "digest-new", { replaces: "c-old" }),
  ]);
  await service.resume();
  const publication = await service.selectPurpose({ workId: "w-1", ...PURPOSE });
  assert.equal(publication.status, "published");
  assert.deepEqual(publication.basis.decisions.map((d) => d.clipId), ["c-new"]);
  const explained = service.explainPublication(publication.id);
  assert.deepEqual(explained.replacedClips, [{ from: "c-old", to: "c-new", at: explained.replacedClips[0].at }]);
});

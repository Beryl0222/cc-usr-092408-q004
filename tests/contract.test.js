import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { IntakeService } from "../src/service.js";
import { validateEvent } from "../src/validator.js";
import { clipRecord, consentRecord, credentialRecord, workRecord } from "./factories.js";

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("联调样例批次可以完整入库", async () => {
  const batch = JSON.parse(await readFile(new URL("../data/sample-batch.json", import.meta.url), "utf8"));
  const service = await IntakeService.open();
  const response = await service.receiveBatch(batch.requestId, batch.records);
  assert.deepEqual(response.rejected, []);
  assert.deepEqual(response.quarantined, []);
  assert.equal(response.accepted.length, batch.records.length);
});

test("服务产生的全部事件都符合领域契约", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  const eventTypes = new Set(schema.properties.event_type.enum);
  const aggregateTypes = new Set(schema.properties.aggregate_type.enum);

  const service = await IntakeService.open();
  await service.receiveBatch("req-contract", [
    workRecord("w-1", "digest-w1"),
    clipRecord("c-1", "w-1", "digest-c1", { requiresConsent: true, flags: { hasMinor: true } }),
    consentRecord("d-1", "w-1", ["c-1"]),
    credentialRecord("cred-1", "w-1"),
    workRecord("w-2", "digest-w1"),
  ]);
  await service.resume();
  const [suggestion] = service.associations();
  await service.decideMerge({ suggestionId: suggestion.id, merge: true, editor: "编辑甲" });
  await service.resolveReview({ clipId: "c-1", role: "minor_protection", approved: true, reviewer: "复核员" });
  const publication = await service.selectPurpose({ workId: "w-1", purpose: "broadcast", territory: "CN" });
  await service.withdrawConsent({ declarationId: "d-1", by: "出镜人物" });
  await service.resume();

  assert.ok(service.events().length > 0);
  for (const event of service.events()) {
    assert.deepEqual(validateEvent(event), [], `事件信封不完整：${event.event_type}`);
    assert.ok(eventTypes.has(event.event_type), `未登记的事件类型：${event.event_type}`);
    assert.ok(aggregateTypes.has(event.aggregate_type), `未登记的聚合类型：${event.aggregate_type}`);
  }
  assert.ok(publication.id);
});

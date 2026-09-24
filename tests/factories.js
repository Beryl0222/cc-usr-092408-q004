import { IntakeService } from "../src/service.js";

export const T0 = "2026-09-21T09:00:00+08:00";

let seq = 0;

export function envelope(eventType, aggregateType, aggregateId, payload, overrides = {}) {
  seq += 1;
  return {
    event_id: `evt-test-${seq}`,
    event_type: eventType,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    occurred_at: T0,
    version: 1,
    summary: `${eventType}:${aggregateId}`,
    payload,
    ...overrides,
  };
}

export const workRecord = (id, digest, payload = {}) =>
  envelope("WORK_REGISTERED", "work", id, {
    workId: id, title: `作品${id}`, digest, submissionId: "sub-1", ...payload,
  });

export const clipRecord = (id, workId, digest, payload = {}) =>
  envelope("CLIP_REGISTERED", "media_clip", id, {
    clipId: id, workId, digest, submissionId: "sub-1", ...payload,
  });

export const consentRecord = (id, workId, clipIds, payload = {}) =>
  envelope("DECLARATION_SUBMITTED", "declaration", id, {
    declarationId: id, workId, clipIds, dtype: "PORTRAIT_CONSENT",
    digest: `digest-${id}`, submissionId: "sub-1", ...payload,
  });

export const credentialRecord = (id, workId, payload = {}) =>
  envelope("CREDENTIAL_SUBMITTED", "rights_credential", id, {
    credentialId: id, workId, partner: "合作方甲",
    scope: { purposes: ["broadcast"], territories: ["CN"] },
    validFrom: "2026-01-01T00:00:00+08:00", validTo: "2027-01-01T00:00:00+08:00",
    digest: `digest-${id}`, submissionId: "sub-1", ...payload,
  });

export const redactionRecord = (id, workId, sourceClipId, digest, payload = {}) =>
  envelope("REDACTION_REGISTERED", "redacted_variant", id, {
    redactionId: id, workId, sourceClipId, digest, method: "blur",
    submissionId: "sub-1", ...payload,
  });

// 常见布景：作品 + 需人物同意的片段 + 同意声明 + 授权凭证，并完成授权核验。
export async function serviceWithCleanWork(options = {}) {
  const service = await IntakeService.open({ clock: () => T0, ...options });
  await service.receiveBatch("req-setup", [
    workRecord("w-1", "digest-w1"),
    clipRecord("c-1", "w-1", "digest-c1", { requiresConsent: true }),
    consentRecord("d-1", "w-1", ["c-1"]),
    credentialRecord("cred-1", "w-1"),
  ]);
  await service.resume();
  return service;
}

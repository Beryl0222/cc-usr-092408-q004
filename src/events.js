// 领域事件类型与事件构造。事件一旦写入只追加日志即不可变；
// 业务更正必须产生后继事件，而不是改写旧记录。

export const EventType = Object.freeze({
  BATCH_RECEIVED: "BATCH_RECEIVED",
  SUBMISSION_RECEIVED: "SUBMISSION_RECEIVED",
  WORK_REGISTERED: "WORK_REGISTERED",
  CLIP_REGISTERED: "CLIP_REGISTERED",
  DECLARATION_RECORDED: "DECLARATION_RECORDED",
  CREDENTIAL_RECORDED: "CREDENTIAL_RECORDED",
  WORKS_ASSOCIATED: "WORKS_ASSOCIATED",
  WORKS_MERGED: "WORKS_MERGED",
  WORK_QUARANTINED: "WORK_QUARANTINED",
  WORK_QUARANTINE_RESOLVED: "WORK_QUARANTINE_RESOLVED",
  EVIDENCE_REQUESTED: "EVIDENCE_REQUESTED",
  VERIFICATION_ASSIGNED: "VERIFICATION_ASSIGNED",
  VERIFICATION_APPROVED: "VERIFICATION_APPROVED",
  VERIFICATION_REJECTED: "VERIFICATION_REJECTED",
  RIGHTS_CLEARED: "RIGHTS_CLEARED",
  PARTNER_CONFIRMATION_REQUESTED: "PARTNER_CONFIRMATION_REQUESTED",
  PARTNER_CONFIRMED: "PARTNER_CONFIRMED",
  PARTNER_DECLINED: "PARTNER_DECLINED",
  PUBLICATION_BASIS_FROZEN: "PUBLICATION_BASIS_FROZEN",
  PUBLICATION_RELEASED: "PUBLICATION_RELEASED",
  CONSENT_WITHDRAWN: "CONSENT_WITHDRAWN",
  POST_PUBLICATION_ACTION_APPENDED: "POST_PUBLICATION_ACTION_APPENDED",
  ASSET_EDITED: "ASSET_EDITED",
  CLIP_REPLACED: "CLIP_REPLACED",
  SANITIZED_VARIANT_CREATED: "SANITIZED_VARIANT_CREATED",
  VARIANT_PUBLISHED: "VARIANT_PUBLISHED",
});

export const AggregateType = Object.freeze({
  BATCH: "processing_batch",
  SUBMISSION: "submission",
  WORK: "work",
  CLIP: "media_clip",
  DECLARATION: "declaration",
  RIGHTS: "rights_record",
  VERIFICATION: "verification_case",
  BASIS: "publication_basis",
  PUBLICATION: "publication",
  VARIANT: "publication_variant",
});

// 触发不同复核角色的片段属性。
export const ReviewKind = Object.freeze({
  MINOR: "minor", // 未成年人
  SENSITIVE_GEOGRAPHY: "sensitive_geography", // 受限/敏感地理信息
  COPYRIGHT: "copyright", // 版权范围
  PORTRAIT: "portrait", // 人物肖像
});

let counter = 0;
export function makeEventId(prefix) {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${rand}`;
}

// 构造一个不可变事件对象。version 由存储层按聚合分配，这里不预设。
export function makeEvent({
  eventType,
  aggregateType,
  aggregateId,
  payload = {},
  summary,
  requestId = null,
  occurredAt = new Date().toISOString(),
}) {
  return {
    event_id: makeEventId(eventType.toLowerCase()),
    event_type: eventType,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    occurred_at: occurredAt,
    version: 0,
    summary: summary ?? eventType,
    ...(requestId ? { request_id: requestId } : {}),
    payload,
  };
}

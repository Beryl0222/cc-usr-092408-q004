// 领域决策：纯函数。(读模型, 命令, 上下文) -> { events, outbox, result }
// 不触碰存储；写库、幂等、恢复都由外层负责。

import { createHash } from "node:crypto";

import { AggregateType as A, EventType as T, ReviewKind, makeEvent, makeEventId } from "./events.js";
import {
  activeCredentials,
  pendingVerifications,
  relatedWorks,
  workOf,
} from "./projections.js";

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function contentDigest(summary) {
  return createHash("sha256").update(String(summary), "utf8").digest("hex").slice(0, 16);
}

// 片段属性 -> 复核角色。未成年人与敏感地理位置分流到不同角色。
const REVIEW_ROLE = {
  [ReviewKind.MINOR]: "minor_protection_reviewer",
  [ReviewKind.SENSITIVE_GEOGRAPHY]: "geo_compliance_reviewer",
  [ReviewKind.COPYRIGHT]: "rights_reviewer",
  [ReviewKind.PORTRAIT]: "portrait_consent_reviewer",
};

function verificationEventsForClip(workId, clip, ctx) {
  const kinds = [ReviewKind.COPYRIGHT];
  if (clip.has_minor) kinds.push(ReviewKind.MINOR);
  if (clip.has_sensitive_geo) kinds.push(ReviewKind.SENSITIVE_GEOGRAPHY);
  if ((clip.consent_scope ?? "unknown") !== "granted") kinds.push(ReviewKind.PORTRAIT);
  return kinds.map((kind) => {
    const verificationId = makeEventId("verification");
    return {
      event: makeEvent({
        eventType: T.VERIFICATION_ASSIGNED,
        aggregateType: A.VERIFICATION,
        aggregateId: verificationId,
        requestId: ctx.requestId,
        occurredAt: ctx.now,
        summary: `分派${kind}复核：${clip.clip_id}`,
        payload: {
          verification_id: verificationId,
          work_id: workId,
          clip_id: clip.clip_id,
          kind,
          assignee_role: REVIEW_ROLE[kind],
        },
      }),
      outbox: {
        message_id: makeEventId("notice"),
        kind: "verification_assignment",
        verification_id: verificationId,
        role: REVIEW_ROLE[kind],
        clip_id: clip.clip_id,
        work_id: workId,
        status: "pending",
        attempts: 0,
        created_at: ctx.now,
      },
    };
  });
}

// ---- 批量入库：坏记录不拖垮整批 ----

export function intakeBatch(model, cmd, ctx) {
  const events = [];
  const outbox = [];
  const result = { batch_id: cmd.batch_id, accepted: [], rejected: [], quarantined: [], associated: [] };
  const seenSubmissions = new Set();
  const seenWorkIds = new Map(); // 本批内已出现 work_id -> 摘要
  const batchDigests = new Map(); // 本批内已登记摘要 -> work_id

  const header = makeEvent({
    eventType: T.BATCH_RECEIVED,
    aggregateType: A.BATCH,
    aggregateId: cmd.batch_id,
    requestId: ctx.requestId,
    occurredAt: ctx.now,
    summary: `接收批次 ${cmd.batch_id}`,
    payload: { batch_id: cmd.batch_id, total: (cmd.records ?? []).length, accepted: 0, rejected: 0, quarantined: 0 },
  });
  events.push(header);

  for (const record of cmd.records ?? []) {
    try {
      const r = intakeRecord(model, record, events, outbox, ctx, seenSubmissions, seenWorkIds, batchDigests);
      result[r.kind].push(r.detail);
    } catch (err) {
      // 单条坏记录只进 rejected，不影响其余作品。
      result.rejected.push({
        submission_id: record?.submission_id ?? null,
        reason: err.message,
      });
    }
  }

  Object.assign(header.payload, {
    accepted: result.accepted.length,
    rejected: result.rejected.length,
    quarantined: result.quarantined.length,
    associated: result.associated.length,
  });
  header.summary = `接收批次 ${cmd.batch_id}：${result.accepted.length} 件入库，${result.rejected.length} 件拒收`;
  return { events, outbox, result };
}

function intakeRecord(model, record, events, outbox, ctx, seenSubmissions, seenWorkIds, batchDigests) {
  if (!record || typeof record !== "object") throw new DomainError("BAD_RECORD", "记录不是对象");
  const { submission_id: submissionId, work } = record;
  if (!submissionId) throw new DomainError("BAD_RECORD", "缺少 submission_id");
  if (seenSubmissions.has(submissionId)) throw new DomainError("BAD_RECORD", `批次内重复投稿：${submissionId}`);
  seenSubmissions.add(submissionId);
  if (!work?.work_id) throw new DomainError("BAD_RECORD", "缺少 work.work_id");
  if (!work.content_summary && !work.content_digest) {
    throw new DomainError("BAD_RECORD", "缺少内容摘要");
  }
  const digest = work.content_digest ?? contentDigest(work.content_summary);
  const workId = work.work_id;

  events.push(
    makeEvent({
      eventType: T.SUBMISSION_RECEIVED,
      aggregateType: A.SUBMISSION,
      aggregateId: submissionId,
      requestId: ctx.requestId,
      occurredAt: ctx.now,
      summary: `收到投稿 ${submissionId}`,
      payload: { submission_id: submissionId, work_id: workId },
    }),
  );

  const persisted = model.works.get(workId);
  const inFlightDigest = seenWorkIds.get(workId);
  const existingDigest = persisted?.content_digest ?? inFlightDigest ?? null;
  if (existingDigest !== null && existingDigest !== digest) {
    // 编号相同而摘要不同：隔离待查，不覆盖、不合并。
    events.push(
      makeEvent({
        eventType: T.WORK_QUARANTINED,
        aggregateType: A.WORK,
        aggregateId: workId,
        requestId: ctx.requestId,
        occurredAt: ctx.now,
        summary: `编号 ${workId} 摘要不一致，隔离待查`,
        payload: {
          work_id: workId,
          reason: "digest_mismatch",
          incoming_digest: digest,
          existing_digest: existingDigest,
        },
      }),
    );
    return { kind: "quarantined", detail: { work_id: workId, reason: "digest_mismatch" } };
  }
  if (persisted || inFlightDigest !== undefined) {
    // 同编号同摘要（可能来自本批稍后提交的事件）：视作重复，不再登记谱系。
    return { kind: "accepted", detail: { work_id: workId, duplicate: true } };
  }
  seenWorkIds.set(workId, digest);

  events.push(
    makeEvent({
      eventType: T.WORK_REGISTERED,
      aggregateType: A.WORK,
      aggregateId: workId,
      requestId: ctx.requestId,
      occurredAt: ctx.now,
      summary: `登记作品《${work.title ?? workId}》`,
      payload: {
        work_id: workId,
        title: work.title ?? null,
        content_digest: digest,
        submitter: work.submitter ?? null,
      },
    }),
  );

  // 内容摘要相同：只提示关联，是否合并由编辑决定（历史作品与本批作品都要比对）。
  const peers = new Set([...(model.digestIndex.get(digest) ?? [])]);
  if (batchDigests.has(digest)) peers.add(batchDigests.get(digest));
  peers.delete(workId);
  let associated = null;
  for (const other of peers) {
    events.push(
      makeEvent({
        eventType: T.WORKS_ASSOCIATED,
        aggregateType: A.WORK,
        aggregateId: workId,
        requestId: ctx.requestId,
        occurredAt: ctx.now,
        summary: `作品 ${workId} 与 ${other} 摘要相同，提示关联`,
        payload: { work_id: workId, other_work_id: other, reason: "same_content_digest" },
      }),
    );
    associated = { work_id: workId, other_work_id: other };
  }
  batchDigests.set(digest, workId);

  for (const clip of work.clips ?? []) {
    if (!clip.clip_id) throw new DomainError("BAD_RECORD", `作品 ${workId} 的片段缺少 clip_id`);
    events.push(
      makeEvent({
        eventType: T.CLIP_REGISTERED,
        aggregateType: A.CLIP,
        aggregateId: clip.clip_id,
        requestId: ctx.requestId,
        occurredAt: ctx.now,
        summary: `登记片段 ${clip.clip_id}`,
        payload: {
          clip_id: clip.clip_id,
          work_id: workId,
          kind: clip.kind ?? "footage",
          label: clip.label ?? null,
          has_minor: Boolean(clip.has_minor),
          has_sensitive_geo: Boolean(clip.has_sensitive_geo),
          consent_scope: clip.consent_scope ?? "unknown",
        },
      }),
    );
    for (const { event, outbox: notice } of verificationEventsForClip(workId, clip, ctx)) {
      events.push(event);
      outbox.push(notice);
    }
  }

  for (const decl of work.declarations ?? []) {
    const declarationId = decl.declaration_id ?? makeEventId("declaration");
    events.push(
      makeEvent({
        eventType: T.DECLARATION_RECORDED,
        aggregateType: A.DECLARATION,
        aggregateId: declarationId,
        requestId: ctx.requestId,
        occurredAt: ctx.now,
        summary: `记录投稿人声明`,
        payload: {
          declaration_id: declarationId,
          work_id: workId,
          submitter: decl.submitter ?? work.submitter ?? null,
          statement: decl.statement ?? null,
        },
      }),
    );
  }

  for (const cred of work.credentials ?? []) {
    const credentialId = cred.credential_id ?? makeEventId("credential");
    events.push(
      makeEvent({
        eventType: T.CREDENTIAL_RECORDED,
        aggregateType: A.RIGHTS,
        aggregateId: credentialId,
        requestId: ctx.requestId,
        occurredAt: ctx.now,
        summary: `登记权利凭证 ${cred.credential_type}`,
        payload: {
          credential_id: credentialId,
          work_id: workId,
          credential_type: cred.credential_type,
          scope: cred.scope ?? [],
          territory: cred.territory ?? null,
          valid_from: cred.valid_from ?? null,
          valid_until: cred.valid_until ?? null,
          partner: cred.partner ?? null,
        },
      }),
    );
    if (cred.partner) pushPartnerRequest(outbox, events, credentialId, workId, cred.partner, ctx);
  }
  if ((work.credentials ?? []).length === 0) {
    events.push(
      makeEvent({
        eventType: T.EVIDENCE_REQUESTED,
        aggregateType: A.WORK,
        aggregateId: workId,
        requestId: ctx.requestId,
        occurredAt: ctx.now,
        summary: `作品 ${workId} 缺少权利凭证，请投稿人补交`,
        payload: { work_id: workId, missing: "credentials" },
      }),
    );
  }

  for (const variant of work.variants ?? []) {
    const variantId = variant.variant_id ?? makeEventId("variant");
    events.push(
      makeEvent({
        eventType: T.SANITIZED_VARIANT_CREATED,
        aggregateType: A.VARIANT,
        aggregateId: variantId,
        requestId: ctx.requestId,
        occurredAt: ctx.now,
        summary: `登记脱敏版本`,
        payload: {
          variant_id: variantId,
          work_id: workId,
          source_clip_id: variant.source_clip_id,
          redaction: variant.redaction ?? "unspecified",
        },
      }),
    );
  }

  const detail = { work_id: workId };
  return associated
    ? { kind: "associated", detail: { ...detail, ...associated } }
    : { kind: "accepted", detail };
}

// ---- 复核决定 ----

export function decideVerification(model, cmd, ctx) {
  const v = model.verifications.get(cmd.verification_id);
  if (!v) throw new DomainError("NOT_FOUND", `复核任务不存在：${cmd.verification_id}`);
  if (v.status !== "pending") {
    // 已决任务重复决定：直接返回现状，保证重放安全。
    return { events: [], outbox: [], result: { verification_id: v.verification_id, status: v.status } };
  }
  const approved = cmd.decision === "approved";
  const events = [
    makeEvent({
      eventType: approved ? T.VERIFICATION_APPROVED : T.VERIFICATION_REJECTED,
      aggregateType: A.VERIFICATION,
      aggregateId: v.verification_id,
      requestId: ctx.requestId,
      occurredAt: ctx.now,
      summary: `${v.kind} 复核${approved ? "通过" : "驳回"}`,
      payload: { verification_id: v.verification_id, note: cmd.note ?? null },
    }),
  ];

  // 该作品全部复核通过后，记一次权利核验完成。
  const siblings = [...model.verifications.values()].filter(
    (other) => other.work_id === v.work_id && other.verification_id !== v.verification_id,
  );
  const allApproved = approved && siblings.every((other) => other.status === "approved");
  if (allApproved) {
    events.push(
      makeEvent({
        eventType: T.RIGHTS_CLEARED,
        aggregateType: A.WORK,
        aggregateId: v.work_id,
        requestId: ctx.requestId,
        occurredAt: ctx.now,
        summary: `作品 ${v.work_id} 权利核验完成`,
        payload: { work_id: v.work_id },
      }),
    );
  }
  return { events, outbox: [], result: { verification_id: v.verification_id, status: approved ? "approved" : "rejected" } };
}

// ---- 合作方确认 ----

function pushPartnerRequest(outbox, events, credentialId, workId, partner, ctx) {
  events.push(
    makeEvent({
      eventType: T.PARTNER_CONFIRMATION_REQUESTED,
      aggregateType: A.RIGHTS,
      aggregateId: credentialId,
      requestId: ctx.requestId,
      occurredAt: ctx.now,
      summary: `请求合作方 ${partner} 确认凭证 ${credentialId}`,
      payload: { credential_id: credentialId, work_id: workId, partner },
    }),
  );
  outbox.push({
    message_id: makeEventId("notice"),
    kind: "partner_confirmation_request",
    credential_id: credentialId,
    work_id: workId,
    partner,
    status: "pending",
    attempts: 0,
    created_at: ctx.now,
  });
}

// 补交授权（迟到的凭证）：只影响之后的冻结，不改写任何已冻结依据。
export function addCredential(model, cmd, ctx) {
  workOf(model, cmd.work_id); // 作品必须存在
  if (model.credentials.has(cmd.credential.credential_id)) {
    return { events: [], outbox: [], result: { credential_id: cmd.credential.credential_id, duplicate: true } };
  }
  const events = [];
  const outbox = [];
  const credentialId = cmd.credential.credential_id;
  events.push(
    makeEvent({
      eventType: T.CREDENTIAL_RECORDED,
      aggregateType: A.RIGHTS,
      aggregateId: credentialId,
      requestId: ctx.requestId,
      occurredAt: ctx.now,
      summary: `补交权利凭证 ${cmd.credential.credential_type}`,
      payload: {
        credential_id: credentialId,
        work_id: cmd.work_id,
        credential_type: cmd.credential.credential_type,
        scope: cmd.credential.scope ?? [],
        territory: cmd.credential.territory ?? null,
        valid_from: cmd.credential.valid_from ?? null,
        valid_until: cmd.credential.valid_until ?? null,
        partner: cmd.credential.partner ?? null,
        supplemental: true,
      },
    }),
  );
  if (cmd.credential.partner) pushPartnerRequest(outbox, events, credentialId, cmd.work_id, cmd.credential.partner, ctx);
  return { events, outbox, result: { credential_id: credentialId, work_id: cmd.work_id, supplemental: true } };
}

export function confirmPartner(model, cmd, ctx) {
  const cred = model.credentials.get(cmd.credential_id);
  if (!cred) throw new DomainError("NOT_FOUND", `权利凭证不存在：${cmd.credential_id}`);
  if (cred.partner_confirmed !== false) {
    return { events: [], outbox: [], result: { credential_id: cred.credential_id, partner_confirmed: cred.partner_confirmed } };
  }
  const confirmed = cmd.decision === "confirmed";
  const events = [
    makeEvent({
      eventType: confirmed ? T.PARTNER_CONFIRMED : T.PARTNER_DECLINED,
      aggregateType: A.RIGHTS,
      aggregateId: cred.credential_id,
      requestId: ctx.requestId,
      occurredAt: ctx.now,
      summary: `合作方${confirmed ? "确认" : "拒绝"}凭证 ${cred.credential_id}`,
      payload: { credential_id: cred.credential_id, partner: cred.partner },
    }),
  ];
  return { events, outbox: [], result: { credential_id: cred.credential_id, partner_confirmed: confirmed } };
}

// ---- 冻结发布依据 ----

export function freezeBasis(model, cmd, ctx) {
  const work = workOf(model, cmd.work_id);
  if (work.status !== "registered") {
    throw new DomainError("BAD_STATE", `作品 ${cmd.work_id} 状态为 ${work.status}，不能冻结依据`);
  }
  const pending = pendingVerifications(model, cmd.work_id);
  if (pending.length > 0) {
    throw new DomainError(
      "VERIFICATION_PENDING",
      `作品 ${cmd.work_id} 尚有 ${pending.length} 项复核未完成`,
    );
  }
  const rejected = [...model.verifications.values()].filter(
    (v) => v.work_id === cmd.work_id && v.status === "rejected",
  );
  if (rejected.length > 0) {
    throw new DomainError("VERIFICATION_REJECTED", `作品 ${cmd.work_id} 存在被驳回的复核`);
  }
  const usable = activeCredentials(model, cmd.work_id, cmd.purpose, ctx.now);
  if (usable.length === 0) {
    throw new DomainError("NO_RIGHTS", `作品 ${cmd.work_id} 在用途 ${cmd.purpose} 下没有有效权利凭证`);
  }

  // 冻结当时有效的版权范围、人物同意与地域限制；之后的变化不改写这份快照。
  const clips = work.clip_ids.map((id) => model.clips.get(id)).filter(Boolean);
  const snapshot = {
    purpose: cmd.purpose,
    credentials: usable.map((c) => ({
      credential_id: c.credential_id,
      credential_type: c.credential_type,
      scope: c.scope,
      territory: c.territory,
      valid_from: c.valid_from,
      valid_until: c.valid_until,
      partner: c.partner,
      partner_confirmed: c.partner_confirmed,
    })),
    consent: clips.map((c) => ({ clip_id: c.clip_id, consent_scope: c.consent_scope })),
    geo_restricted_clips: clips.filter((c) => c.has_sensitive_geo).map((c) => c.clip_id),
    minor_clips: clips.filter((c) => c.has_minor).map((c) => c.clip_id),
    clip_ids: [...work.clip_ids],
  };
  const basisId = makeEventId("basis");
  const events = [
    makeEvent({
      eventType: T.PUBLICATION_BASIS_FROZEN,
      aggregateType: A.BASIS,
      aggregateId: basisId,
      requestId: ctx.requestId,
      occurredAt: ctx.now,
      summary: `冻结作品 ${cmd.work_id} 用途 ${cmd.purpose} 的发布依据`,
      payload: { basis_id: basisId, work_id: cmd.work_id, purpose: cmd.purpose, snapshot },
    }),
  ];
  return { events, outbox: [], result: { basis_id: basisId, work_id: cmd.work_id, purpose: cmd.purpose } };
}

// ---- 发布 ----

export function releasePublication(model, cmd, ctx) {
  const basis = model.bases.get(cmd.basis_id);
  if (!basis) throw new DomainError("NOT_FOUND", `发布依据不存在：${cmd.basis_id}`);
  if (basis.work_id !== cmd.work_id) {
    throw new DomainError("BAD_STATE", `依据 ${cmd.basis_id} 不属于作品 ${cmd.work_id}`);
  }
  // 撤回只阻止之后的新使用：冻结依据里引用的凭证若已撤回，则本次发布被阻止。
  const withdrawn = basis.snapshot.credentials
    .map((c) => model.credentials.get(c.credential_id))
    .filter((c) => c && c.status === "withdrawn");
  if (withdrawn.length > 0) {
    throw new DomainError(
      "CONSENT_WITHDRAWN",
      `凭证已撤回，阻止新发布：${withdrawn.map((c) => c.credential_id).join("、")}`,
    );
  }
  const publicationId = makeEventId("publication");
  const events = [
    makeEvent({
      eventType: T.PUBLICATION_RELEASED,
      aggregateType: A.PUBLICATION,
      aggregateId: publicationId,
      requestId: ctx.requestId,
      occurredAt: ctx.now,
      summary: `依据 ${cmd.basis_id} 发布作品 ${cmd.work_id}`,
      payload: {
        publication_id: publicationId,
        work_id: cmd.work_id,
        basis_id: cmd.basis_id,
        purpose: basis.purpose,
      },
    }),
  ];
  return { events, outbox: [], result: { publication_id: publicationId, basis_id: cmd.basis_id } };
}

// ---- 撤回同意 ----

export function withdrawConsent(model, cmd, ctx) {
  const cred = model.credentials.get(cmd.credential_id);
  if (!cred) throw new DomainError("NOT_FOUND", `权利凭证不存在：${cmd.credential_id}`);
  if (cred.status === "withdrawn") {
    return { events: [], outbox: [], result: { credential_id: cred.credential_id, status: "withdrawn" } };
  }
  const events = [
    makeEvent({
      eventType: T.CONSENT_WITHDRAWN,
      aggregateType: A.RIGHTS,
      aggregateId: cred.credential_id,
      requestId: ctx.requestId,
      occurredAt: ctx.now,
      summary: `撤回凭证 ${cred.credential_id}`,
      payload: { credential_id: cred.credential_id, work_id: cred.work_id },
    }),
  ];
  const outbox = [];
  const affected = [];
  // 已经发生的合规发布不受撤回影响，但要追加处置记录并通知。
  for (const pub of model.publications.values()) {
    const basis = model.bases.get(pub.basis_id);
    const used = basis?.snapshot.credentials.some((c) => c.credential_id === cred.credential_id);
    if (pub.work_id === cred.work_id && used) {
      events.push(
        makeEvent({
          eventType: T.POST_PUBLICATION_ACTION_APPENDED,
          aggregateType: A.PUBLICATION,
          aggregateId: pub.publication_id,
          requestId: ctx.requestId,
          occurredAt: ctx.now,
          summary: `发布 ${pub.publication_id} 追加撤回处置记录`,
          payload: {
            publication_id: pub.publication_id,
            action: "consent_withdrawn_notice",
            detail: `凭证 ${cred.credential_id} 已撤回，本次发布属撤回前的合规使用`,
          },
        }),
      );
      affected.push(pub.publication_id);
    }
  }
  outbox.push({
    message_id: makeEventId("notice"),
    kind: "consent_withdrawn",
    credential_id: cred.credential_id,
    work_id: cred.work_id,
    affected_publications: affected,
    status: "pending",
    attempts: 0,
    created_at: ctx.now,
  });
  return { events, outbox, result: { credential_id: cred.credential_id, status: "withdrawn", affected_publications: affected } };
}

// ---- 片段替换 ----

export function replaceClip(model, cmd, ctx) {
  const work = workOf(model, cmd.work_id);
  if (!work.clip_ids.includes(cmd.old_clip_id)) {
    throw new DomainError("NOT_FOUND", `作品 ${cmd.work_id} 中没有片段 ${cmd.old_clip_id}`);
  }
  const clip = cmd.new_clip;
  if (!clip?.clip_id) throw new DomainError("BAD_RECORD", "新片段缺少 clip_id");
  const events = [
    makeEvent({
      eventType: T.CLIP_REGISTERED,
      aggregateType: A.CLIP,
      aggregateId: clip.clip_id,
      requestId: ctx.requestId,
      occurredAt: ctx.now,
      summary: `登记替换片段 ${clip.clip_id}`,
      payload: {
        clip_id: clip.clip_id,
        work_id: cmd.work_id,
        kind: clip.kind ?? "footage",
        label: clip.label ?? null,
        has_minor: Boolean(clip.has_minor),
        has_sensitive_geo: Boolean(clip.has_sensitive_geo),
        consent_scope: clip.consent_scope ?? "unknown",
      },
    }),
    makeEvent({
      eventType: T.CLIP_REPLACED,
      aggregateType: A.WORK,
      aggregateId: cmd.work_id,
      requestId: ctx.requestId,
      occurredAt: ctx.now,
      summary: `作品 ${cmd.work_id} 片段 ${cmd.old_clip_id} 替换为 ${clip.clip_id}`,
      payload: {
        work_id: cmd.work_id,
        old_clip_id: cmd.old_clip_id,
        new_clip_id: clip.clip_id,
        reason: cmd.reason ?? null,
      },
    }),
  ];
  const outbox = [];
  for (const { event, outbox: notice } of verificationEventsForClip(cmd.work_id, clip, ctx)) {
    events.push(event);
    outbox.push(notice);
  }
  return { events, outbox, result: { work_id: cmd.work_id, old_clip_id: cmd.old_clip_id, new_clip_id: clip.clip_id } };
}

// ---- 关联与合并（编辑决定）----

export function mergeWorks(model, cmd, ctx) {
  const target = workOf(model, cmd.work_id);
  const source = workOf(model, cmd.merged_work_id);
  if (target.status !== "registered" || source.status !== "registered") {
    throw new DomainError("BAD_STATE", "只有登记状态的作品可以合并");
  }
  const events = [
    makeEvent({
      eventType: T.WORKS_MERGED,
      aggregateType: A.WORK,
      aggregateId: cmd.work_id,
      requestId: ctx.requestId,
      occurredAt: ctx.now,
      summary: `作品 ${cmd.merged_work_id} 并入 ${cmd.work_id}`,
      payload: { work_id: cmd.work_id, merged_work_id: cmd.merged_work_id, decided_by: cmd.decided_by ?? null },
    }),
  ];
  return { events, outbox: [], result: { work_id: cmd.work_id, merged_work_id: cmd.merged_work_id } };
}

export function resolveQuarantine(model, cmd, ctx) {
  workOf(model, cmd.work_id);
  if (!model.quarantine.has(cmd.work_id)) {
    throw new DomainError("BAD_STATE", `作品 ${cmd.work_id} 不在隔离中`);
  }
  const events = [
    makeEvent({
      eventType: T.WORK_QUARANTINE_RESOLVED,
      aggregateType: A.WORK,
      aggregateId: cmd.work_id,
      requestId: ctx.requestId,
      occurredAt: ctx.now,
      summary: `解除作品 ${cmd.work_id} 的隔离`,
      payload: { work_id: cmd.work_id, resolution: cmd.resolution ?? "accepted", decided_by: cmd.decided_by ?? null },
    }),
  ];
  return { events, outbox: [], result: { work_id: cmd.work_id, status: "registered" } };
}

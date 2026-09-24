// 投影：把只追加事件折叠成当前读模型。
// 投影可以随时丢弃重建——事件日志才是事实来源。

import { AggregateType as A, EventType as T } from "./events.js";

export function emptyModel() {
  return {
    works: new Map(), // work_id -> 作品
    clips: new Map(), // clip_id -> 素材片段
    declarations: new Map(), // declaration_id -> 投稿人声明
    credentials: new Map(), // credential_id -> 权利凭证
    verifications: new Map(), // verification_id -> 复核任务
    bases: new Map(), // basis_id -> 冻结的发布依据
    publications: new Map(), // publication_id -> 发布记录
    variants: new Map(), // variant_id -> 脱敏版本
    quarantine: new Map(), // work_id -> 隔离原因
    submissions: new Map(), // submission_id -> 投稿登记
    digestIndex: new Map(), // content_digest -> Set<work_id>（相同摘要只提示关联）
  };
}

function ensure(map, id, init) {
  if (!map.has(id)) map.set(id, init());
  return map.get(id);
}

const ensureWork = (m, id) =>
  ensure(m.works, id, () => ({
    work_id: id,
    title: null,
    content_digest: null,
    status: "registered", // registered | quarantined | merged
    merged_into: null,
    clip_ids: [],
    declaration_ids: [],
    credential_ids: [],
    variant_ids: [],
    associations: [], // 仅提示，不自动合并
    rights_cleared: false,
    replaced_clips: [], // 片段替换谱系
    events: 0,
  }));

export function applyEvent(model, event) {
  const p = event.payload ?? {};
  switch (event.event_type) {
    case T.SUBMISSION_RECEIVED: {
      model.submissions.set(event.aggregate_id, {
        submission_id: event.aggregate_id,
        batch_id: p.batch_id ?? null,
        work_id: p.work_id,
        received_at: event.occurred_at,
      });
      break;
    }
    case T.WORK_REGISTERED: {
      const w = ensureWork(model, event.aggregate_id);
      w.title = p.title;
      w.content_digest = p.content_digest;
      w.submitter = p.submitter ?? null;
      w.status = "registered";
      if (p.content_digest) {
        const set = ensure(model.digestIndex, p.content_digest, () => new Set());
        set.add(event.aggregate_id);
      }
      w.events += 1;
      break;
    }
    case T.CLIP_REGISTERED: {
      model.clips.set(event.aggregate_id, {
        clip_id: event.aggregate_id,
        work_id: p.work_id,
        kind: p.kind ?? "footage",
        label: p.label ?? null,
        has_minor: Boolean(p.has_minor),
        has_sensitive_geo: Boolean(p.has_sensitive_geo),
        consent_scope: p.consent_scope ?? "unknown", // granted | revoked | unknown
        registered_at: event.occurred_at,
      });
      const w = ensureWork(model, p.work_id);
      if (!w.clip_ids.includes(event.aggregate_id)) w.clip_ids.push(event.aggregate_id);
      break;
    }
    case T.DECLARATION_RECORDED: {
      model.declarations.set(event.aggregate_id, {
        declaration_id: event.aggregate_id,
        work_id: p.work_id,
        submitter: p.submitter,
        statement: p.statement,
        recorded_at: event.occurred_at,
      });
      ensureWork(model, p.work_id).declaration_ids.push(event.aggregate_id);
      break;
    }
    case T.CREDENTIAL_RECORDED: {
      model.credentials.set(event.aggregate_id, {
        credential_id: event.aggregate_id,
        work_id: p.work_id,
        credential_type: p.credential_type, // license | portrait_consent | geo_permit
        scope: p.scope ?? [],
        territory: p.territory ?? null,
        valid_from: p.valid_from ?? null,
        valid_until: p.valid_until ?? null,
        partner: p.partner ?? null, // 合作方，null 表示无需确认
        partner_confirmed: p.partner ? false : null,
        status: "active", // active | withdrawn
        recorded_at: event.occurred_at,
      });
      ensureWork(model, p.work_id).credential_ids.push(event.aggregate_id);
      break;
    }
    case T.WORKS_ASSOCIATED: {
      const w = ensureWork(model, event.aggregate_id);
      w.associations.push({ with: p.other_work_id, reason: p.reason, at: event.occurred_at });
      break;
    }
    case T.WORKS_MERGED: {
      const target = ensureWork(model, event.aggregate_id);
      const source = ensureWork(model, p.merged_work_id);
      source.status = "merged";
      source.merged_into = event.aggregate_id;
      for (const cid of source.clip_ids) {
        if (!target.clip_ids.includes(cid)) target.clip_ids.push(cid);
        const clip = model.clips.get(cid);
        if (clip) clip.work_id = event.aggregate_id;
      }
      for (const did of source.declaration_ids) {
        if (!target.declaration_ids.includes(did)) target.declaration_ids.push(did);
        const d = model.declarations.get(did);
        if (d) d.work_id = event.aggregate_id;
      }
      for (const cid of source.credential_ids) {
        if (!target.credential_ids.includes(cid)) target.credential_ids.push(cid);
        const c = model.credentials.get(cid);
        if (c) c.work_id = event.aggregate_id;
      }
      break;
    }
    case T.WORK_QUARANTINED: {
      const w = ensureWork(model, event.aggregate_id);
      w.status = "quarantined";
      model.quarantine.set(event.aggregate_id, {
        reason: p.reason,
        conflicting_work_id: p.conflicting_work_id ?? null,
        at: event.occurred_at,
      });
      break;
    }
    case T.WORK_QUARANTINE_RESOLVED: {
      const w = ensureWork(model, event.aggregate_id);
      w.status = "registered";
      model.quarantine.delete(event.aggregate_id);
      break;
    }
    case T.VERIFICATION_ASSIGNED: {
      model.verifications.set(event.aggregate_id, {
        verification_id: event.aggregate_id,
        work_id: p.work_id,
        clip_id: p.clip_id ?? null,
        kind: p.kind, // minor | sensitive_geography | copyright | portrait
        assignee_role: p.assignee_role, // 不同敏感类型分流到不同角色
        status: "pending", // pending | approved | rejected
        decided_at: null,
        note: null,
      });
      break;
    }
    case T.VERIFICATION_APPROVED:
    case T.VERIFICATION_REJECTED: {
      const v = model.verifications.get(event.aggregate_id);
      if (v) {
        v.status = event.event_type === T.VERIFICATION_APPROVED ? "approved" : "rejected";
        v.decided_at = event.occurred_at;
        v.note = p.note ?? null;
      }
      break;
    }
    case T.RIGHTS_CLEARED: {
      ensureWork(model, event.aggregate_id).rights_cleared = true;
      break;
    }
    case T.PARTNER_CONFIRMED:
    case T.PARTNER_DECLINED: {
      const c = model.credentials.get(p.credential_id);
      if (c) c.partner_confirmed = event.event_type === T.PARTNER_CONFIRMED;
      break;
    }
    case T.PUBLICATION_BASIS_FROZEN: {
      // 冻结即快照：之后任何授权变化、撤回、并发入库都不改写这份依据。
      model.bases.set(event.aggregate_id, {
        basis_id: event.aggregate_id,
        work_id: p.work_id,
        purpose: p.purpose,
        frozen_at: event.occurred_at,
        snapshot: structuredClone(p.snapshot),
      });
      break;
    }
    case T.PUBLICATION_RELEASED: {
      model.publications.set(event.aggregate_id, {
        publication_id: event.aggregate_id,
        work_id: p.work_id,
        basis_id: p.basis_id,
        purpose: p.purpose,
        released_at: event.occurred_at,
        post_actions: [], // 发布后追加的处置记录（如撤回通知）
      });
      break;
    }
    case T.POST_PUBLICATION_ACTION_APPENDED: {
      const pub = model.publications.get(p.publication_id);
      if (pub) {
        pub.post_actions.push({
          action: p.action,
          detail: p.detail,
          at: event.occurred_at,
        });
      }
      break;
    }
    case T.CONSENT_WITHDRAWN: {
      const c = model.credentials.get(p.credential_id);
      if (c) c.status = "withdrawn";
      break;
    }
    case T.CLIP_REPLACED: {
      const w = ensureWork(model, p.work_id);
      const idx = w.clip_ids.indexOf(p.old_clip_id);
      if (idx >= 0) {
        if (w.clip_ids.includes(p.new_clip_id)) {
          // 新片段已在登记事件中入列，这里只摘除旧片段。
          w.clip_ids.splice(idx, 1);
        } else {
          w.clip_ids.splice(idx, 1, p.new_clip_id);
        }
      } else if (!w.clip_ids.includes(p.new_clip_id)) {
        w.clip_ids.push(p.new_clip_id);
      }
      w.replaced_clips.push({
        old_clip_id: p.old_clip_id,
        new_clip_id: p.new_clip_id,
        reason: p.reason ?? null,
        at: event.occurred_at,
      });
      const clip = model.clips.get(p.new_clip_id);
      if (clip) clip.work_id = p.work_id;
      break;
    }
    case T.SANITIZED_VARIANT_CREATED: {
      model.variants.set(event.aggregate_id, {
        variant_id: event.aggregate_id,
        work_id: p.work_id,
        source_clip_id: p.source_clip_id,
        redaction: p.redaction, // 脱敏方式
        created_at: event.occurred_at,
      });
      ensureWork(model, p.work_id).variant_ids.push(event.aggregate_id);
      break;
    }
    case T.VARIANT_PUBLISHED: {
      const v = model.variants.get(p.variant_id ?? event.aggregate_id);
      if (v) v.published_at = event.occurred_at;
      break;
    }
    case T.ASSET_EDITED: {
      const clip = model.clips.get(event.aggregate_id);
      if (clip) clip.last_edited_at = event.occurred_at;
      break;
    }
    default:
      break; // 未知事件不阻断重放
  }
  return model;
}

export function buildModel(events) {
  return events.reduce(applyEvent, emptyModel());
}

// ---- 派生查询 ----

export function workOf(model, workId) {
  const w = model.works.get(workId);
  if (!w) throw new Error(`作品不存在：${workId}`);
  return w;
}

// 相同内容摘要的其它作品（只提示关联，不自动合并）。
export function relatedWorks(model, workId) {
  const w = model.works.get(workId);
  if (!w?.content_digest) return [];
  const peers = model.digestIndex.get(w.content_digest) ?? new Set();
  return [...peers].filter((id) => id !== workId);
}

// 某作品在某用途下，当前时刻的有效凭证。
export function activeCredentials(model, workId, purpose, at) {
  const w = model.works.get(workId);
  if (!w) return [];
  const when = Date.parse(at);
  return w.credential_ids
    .map((id) => model.credentials.get(id))
    .filter((c) => c && c.status === "active")
    .filter((c) => !c.scope?.length || c.scope.includes(purpose))
    .filter((c) => !c.valid_from || Date.parse(c.valid_from) <= when)
    .filter((c) => !c.valid_until || Date.parse(c.valid_until) >= when);
}

export function pendingVerifications(model, workId = null) {
  return [...model.verifications.values()].filter(
    (v) => v.status === "pending" && (workId === null || v.work_id === workId),
  );
}

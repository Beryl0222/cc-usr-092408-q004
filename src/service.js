import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { EventStore } from "./eventStore.js";
import { JobJournal } from "./jobs.js";
import { currentClipsOf, replacementChainsOf } from "./lineage.js";
import { evaluateConsent, evaluateCopyright, evaluateGeo } from "./rights.js";
import { validateEvent } from "./validator.js";

// 涉及未成年人与敏感位置的片段分别交给不同角色复核。
export const REVIEW_ROLES = Object.freeze({
  MINOR: "minor_protection",
  GEO: "geo_security",
});

const ENTITY_KIND_BY_EVENT = Object.freeze({
  WORK_REGISTERED: "work",
  CLIP_REGISTERED: "media_clip",
  DECLARATION_SUBMITTED: "declaration",
  CREDENTIAL_SUBMITTED: "rights_credential",
  REDACTION_REGISTERED: "redacted_variant",
});

const ENTITY_ID_FIELD = Object.freeze({
  WORK_REGISTERED: "workId",
  CLIP_REGISTERED: "clipId",
  DECLARATION_SUBMITTED: "declarationId",
  CREDENTIAL_SUBMITTED: "credentialId",
  REDACTION_REGISTERED: "redactionId",
});

const WITHDRAWAL_EVENTS = Object.freeze({
  CONSENT_WITHDRAWN: { kind: "declaration", idField: "declarationId" },
  CREDENTIAL_WITHDRAWN: { kind: "rights_credential", idField: "credentialId" },
});

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function freshState() {
  return {
    entities: new Map(),
    digestIndex: new Map(),
    suggestions: new Map(),
    replacements: [],
    reviews: new Map(),
    publications: new Map(),
    quarantine: [],
  };
}

// 黄河影像征集核验入库服务。
// 所有状态变化都先落成事件再折叠进内存投影；重开服务时重放事件即可恢复。
export class IntakeService {
  #store;
  #jobs;
  #clock = () => new Date().toISOString();
  #requestsPath = null;
  #requests = new Map();
  #state = freshState();

  static async open({ dataDir = null, clock } = {}) {
    const service = new IntakeService();
    if (clock) service.#clock = clock;
    if (dataDir) await mkdir(dataDir, { recursive: true });
    service.#store = await EventStore.open({
      journalPath: dataDir ? path.join(dataDir, "events.jsonl") : null,
    });
    service.#jobs = await JobJournal.open(dataDir ? path.join(dataDir, "jobs.json") : null);
    service.#requestsPath = dataDir ? path.join(dataDir, "requests.json") : null;
    if (service.#requestsPath && existsSync(service.#requestsPath)) {
      const saved = JSON.parse(await readFile(service.#requestsPath, "utf8"));
      for (const [id, entry] of Object.entries(saved)) service.#requests.set(id, entry);
    }
    for (const event of service.#store.all()) service.#fold(event);
    return service;
  }

  // ---- 批量接收 ----

  // 一次批量接收即使混有坏记录也要保住其余作品；
  // 同一请求编号重放返回原结果；编号相同而摘要不同的记录隔离待查。
  async receiveBatch(requestId, records) {
    if (!requestId) throw new Error("缺少请求编号");
    if (!Array.isArray(records) || records.length === 0) throw new Error("批量内容不能为空");
    const hash = sha256(JSON.stringify(records));
    const seen = this.#requests.get(requestId);
    if (seen) {
      if (seen.hash === hash) return seen.response;
      throw new Error(`请求编号冲突：${requestId} 已用于不同内容`);
    }
    const response = { requestId, accepted: [], duplicates: [], quarantined: [], rejected: [] };
    for (const [index, record] of records.entries()) {
      try {
        const outcome = await this.#ingestRecord(record);
        if (outcome.kind === "accepted") response.accepted.push(outcome.id);
        else if (outcome.kind === "duplicate") response.duplicates.push(outcome.id);
        else response.quarantined.push(outcome.id);
      } catch (error) {
        response.rejected.push({ index, event_id: record?.event_id ?? null, errors: [error.message] });
      }
    }
    this.#requests.set(requestId, { hash, response });
    await this.#persistRequests();
    return response;
  }

  async #ingestRecord(record) {
    const errors = validateEvent(record);
    if (errors.length > 0) throw new Error(errors.join("；"));
    const type = record.event_type;
    const kind = ENTITY_KIND_BY_EVENT[type] ?? null;
    let aggregateType = record.aggregate_type;
    let aggregateId = record.aggregate_id;

    if (kind) {
      const id = record.payload?.[ENTITY_ID_FIELD[type]];
      if (!id) throw new Error(`缺少实体编号：${ENTITY_ID_FIELD[type]}`);
      aggregateType = kind;
      aggregateId = id;
      const existing = this.#state.entities.get(id);
      if (existing) {
        if (existing.digest && existing.digest === (record.payload?.digest ?? null)) {
          return { kind: "duplicate", id };
        }
        await this.#emit("RECORD_QUARANTINED", "quarantine", `quarantine-${id}`, `编号相同而摘要不同，隔离待查：${id}`, {
          conflictingId: id,
          existingDigest: existing.digest ?? null,
          incoming: record,
        });
        return { kind: "quarantined", id };
      }
      this.#assertLineageRefs(type, record.payload);
    }

    const withdrawal = WITHDRAWAL_EVENTS[type];
    if (withdrawal) {
      const id = record.payload?.[withdrawal.idField];
      const target = this.#state.entities.get(id);
      if (!target || target.kind !== withdrawal.kind) throw new Error(`撤回对象不存在：${id}`);
      if (target.status === "withdrawn") return { kind: "duplicate", id };
    }
    if (type === "REVIEW_RESOLVED") {
      const { clipId, role } = record.payload ?? {};
      const review = this.#state.reviews.get(clipId)?.get(role);
      if (!review) throw new Error(`片段 ${clipId} 没有 ${role} 复核任务`);
      if (review.status !== "pending") return { kind: "duplicate", id: clipId };
    }
    if (type === "MERGE_DECIDED") {
      const suggestion = this.#state.suggestions.get(record.payload?.suggestionId);
      if (!suggestion) throw new Error(`关联建议不存在：${record.payload?.suggestionId}`);
      if (suggestion.status !== "pending") return { kind: "duplicate", id: suggestion.id };
    }

    // 版本号由服务统一分配，调用方携带的版本不参与排序，保证并发入库时不乱序。
    const stored = {
      ...record,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      version: this.#store.nextVersion(aggregateId),
    };
    await this.#store.append(stored);
    this.#fold(stored);
    await this.#afterEvent(stored);
    return { kind: "accepted", id: aggregateId };
  }

  #assertLineageRefs(type, payload) {
    if (type === "CLIP_REGISTERED" && !this.#state.entities.get(payload?.workId)) {
      throw new Error(`片段所属作品不存在：${payload?.workId}`);
    }
    if (type === "CLIP_REGISTERED" && payload?.replaces && !this.#state.entities.get(payload.replaces)) {
      throw new Error(`被替换的片段不存在：${payload.replaces}`);
    }
    if (type === "REDACTION_REGISTERED" && payload?.sourceClipId && !this.#state.entities.get(payload.sourceClipId)) {
      throw new Error(`脱敏来源片段不存在：${payload.sourceClipId}`);
    }
  }

  // ---- 编辑操作 ----

  // 内容摘要相同只提示关联，是否合并由编辑决定。
  async decideMerge({ suggestionId, merge, editor }) {
    return this.#ingestRecord(this.#command("MERGE_DECIDED", "association", suggestionId, `合并决定：${suggestionId}`, { suggestionId, merge, editor }));
  }

  async resolveReview({ clipId, role, approved, reviewer }) {
    return this.#ingestRecord(this.#command("REVIEW_RESOLVED", "media_clip", clipId, `复核结论：${clipId} / ${role}`, { clipId, role, approved, reviewer }));
  }

  async withdrawConsent({ declarationId, by }) {
    return this.#ingestRecord(this.#command("CONSENT_WITHDRAWN", "declaration", declarationId, `撤回人物同意：${declarationId}`, { declarationId, by }));
  }

  async withdrawCredential({ credentialId, by }) {
    return this.#ingestRecord(this.#command("CREDENTIAL_WITHDRAWN", "rights_credential", credentialId, `撤回授权：${credentialId}`, { credentialId, by }));
  }

  #command(eventType, aggregateType, aggregateId, summary, payload) {
    return {
      event_id: `evt-${randomUUID()}`,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: this.#clock(),
      version: 1,
      summary,
      payload,
    };
  }

  // ---- 发布 ----

  // 编辑选择发布用途时，把当时有效的版权范围、人物同意和地域限制冻结为依据。
  // 冻结之后到达的授权、撤回或新片段都不改变这份依据。
  async selectPurpose({ workId, purpose, territory, editor }) {
    const work = this.#state.entities.get(workId);
    if (!work || work.kind !== "work") throw new Error(`作品不存在：${workId}`);
    const clips = currentClipsOf(this.#state, workId);
    if (clips.length === 0) throw new Error(`作品 ${workId} 没有可发布的片段`);
    const at = this.#clock();
    const entities = [...this.#state.entities.values()];
    const credentials = entities.filter((entity) => entity.kind === "rights_credential");
    const consents = entities.filter((entity) => entity.kind === "declaration" && entity.dtype === "PORTRAIT_CONSENT");
    const decisions = clips.map((clip) => this.#evaluateClip(clip, { credentials, consents, purpose, territory, at }));
    const publicationId = `pub-${workId}-${this.#state.publications.size + 1}`;
    const basis = { id: `basis-${publicationId}`, frozenAt: at, workId, purpose, territory, editor: editor ?? null, decisions };
    await this.#emit("BASIS_FROZEN", "publication", publicationId, `冻结发布依据：${workId} / ${purpose}`, {
      publicationId, workId, purpose, territory, editor: editor ?? null, basis,
    });
    const failed = decisions.filter((decision) => !decision.cleared);
    if (failed.length === 0) {
      await this.#emit("VARIANT_PUBLISHED", "publication", publicationId, `发布成片：${workId} / ${purpose}`, {
        publicationId, basisId: basis.id,
      });
    } else {
      const reasons = failed.map((decision) => `${decision.clipId}：${decision.failureReasons.join("；")}`);
      await this.#emit("PUBLICATION_REJECTED", "publication", publicationId, `发布被拦下：${workId} / ${purpose}`, {
        publicationId, reasons,
      });
    }
    return this.#state.publications.get(publicationId);
  }

  #evaluateClip(clip, { credentials, consents, purpose, territory, at }) {
    const copyright = evaluateCopyright({ clip, credentials, purpose, territory, at });
    const consent = evaluateConsent({ clip, consents });
    const geo = evaluateGeo({ clip, territory });
    const review = this.#reviewOutcome(clip);
    const failureReasons = [];
    if (!copyright.ok) failureReasons.push(copyright.reason);
    if (!consent.ok) failureReasons.push(consent.reason);
    if (!geo.ok) failureReasons.push(geo.reason);
    if (!review.ok) failureReasons.push(review.reason);
    return { clipId: clip.id, copyright, consent, geo, review, cleared: failureReasons.length === 0, failureReasons };
  }

  #reviewOutcome(clip) {
    const required = [];
    if (clip.flags?.hasMinor) required.push(REVIEW_ROLES.MINOR);
    if (clip.flags?.sensitiveGeo) required.push(REVIEW_ROLES.GEO);
    const reviews = this.#state.reviews.get(clip.id) ?? new Map();
    const rejected = required.filter((role) => reviews.get(role)?.status === "rejected");
    if (rejected.length > 0) return { ok: false, pendingRoles: [], reason: `复核未通过：${rejected.join("、")}` };
    const pending = required.filter((role) => reviews.get(role)?.status !== "approved");
    if (pending.length > 0) return { ok: false, pendingRoles: pending, reason: `等待复核：${pending.join("、")}` };
    return { ok: true, pendingRoles: [] };
  }

  // ---- 恢复 ----

  // 中断前尚未完成的核验与撤回通知，在恢复后继续推进。
  async resume() {
    const processed = [];
    for (const job of this.#jobs.pending()) {
      if (job.type === "VERIFY_CREDENTIAL") {
        const credential = this.#state.entities.get(job.credentialId);
        if (credential && credential.kind === "rights_credential" && credential.status === "active" && !credential.confirmed) {
          await this.#emit("CREDENTIAL_CONFIRMED", "rights_credential", job.credentialId, `授权核验完成：${job.credentialId}`, {
            credentialId: job.credentialId,
          });
        }
      } else if (job.type === "NOTIFY_WITHDRAWAL") {
        const aggregateType = job.cause === "CONSENT_WITHDRAWN" ? "declaration" : "rights_credential";
        await this.#emit("WITHDRAWAL_NOTIFIED", aggregateType, job.subject, `撤回通知已送达：${job.subject}`, {
          subject: job.subject,
          publicationId: job.publicationId ?? null,
        });
      }
      await this.#jobs.complete(job.id);
      processed.push(job.id);
    }
    return processed;
  }

  // ---- 查询 ----

  entity(id) {
    return this.#state.entities.get(id) ?? null;
  }

  // 任一实体的谱系：上游来源、被编辑确认合并的关联、待决的关联建议。
  lineageOf(id) {
    const entity = this.#state.entities.get(id);
    if (!entity) throw new Error(`实体不存在：${id}`);
    const suggestionIds = [...this.#state.suggestions.values()]
      .filter((suggestion) => suggestion.entityIds.includes(id))
      .map((suggestion) => suggestion.id);
    return {
      id: entity.id,
      kind: entity.kind,
      digest: entity.digest ?? null,
      parents: entity.parentIds ?? [],
      mergedWith: entity.mergedWith ?? [],
      suggestionIds,
    };
  }

  associations() {
    return [...this.#state.suggestions.values()];
  }

  quarantined() {
    return [...this.#state.quarantine];
  }

  reviewsOf(clipId) {
    const reviews = this.#state.reviews.get(clipId);
    if (!reviews) return {};
    return Object.fromEntries(reviews.entries());
  }

  pendingJobs() {
    return this.#jobs.pending();
  }

  events() {
    return this.#store.all();
  }

  // 打开任一成片都能说明：为何获准、替换过哪些片段、哪些合作方尚未确认。
  explainPublication(publicationId) {
    const publication = this.#state.publications.get(publicationId);
    if (!publication) throw new Error(`发布记录不存在：${publicationId}`);
    const pendingPartners = [
      ...new Set(
        [...this.#state.entities.values()]
          .filter(
            (entity) =>
              entity.kind === "rights_credential" &&
              entity.workId === publication.workId &&
              entity.status === "active" &&
              !entity.confirmed,
          )
          .map((entity) => entity.partner),
      ),
    ];
    return {
      publicationId: publication.id,
      status: publication.status,
      purpose: publication.basis.purpose,
      territory: publication.basis.territory,
      editor: publication.basis.editor,
      frozenAt: publication.basis.frozenAt,
      whyApproved: publication.basis.decisions.map((decision) => ({
        clipId: decision.clipId,
        cleared: decision.cleared,
        copyright: decision.copyright,
        consent: decision.consent,
        geo: decision.geo,
        review: decision.review,
      })),
      replacedClips: replacementChainsOf(this.#state, publication.workId),
      pendingPartners,
      dispositions: publication.dispositions,
      rejectionReasons: publication.rejectionReasons ?? [],
    };
  }

  // ---- 事件副作用与投影 ----

  async #emit(eventType, aggregateType, aggregateId, summary, payload = {}) {
    const event = {
      event_id: `evt-${randomUUID()}`,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: this.#clock(),
      version: this.#store.nextVersion(aggregateId),
      summary,
      payload,
    };
    await this.#store.append(event);
    this.#fold(event);
    return event;
  }

  async #afterEvent(event) {
    const payload = event.payload ?? {};
    if (ENTITY_KIND_BY_EVENT[event.event_type]) {
      await this.#suggestAssociations(event);
    }
    if (event.event_type === "CLIP_REGISTERED") {
      const flags = payload.flags ?? {};
      if (flags.hasMinor) {
        await this.#emit("REVIEW_REQUESTED", "media_clip", payload.clipId, `未成年人片段复核：${payload.clipId}`, {
          clipId: payload.clipId, role: REVIEW_ROLES.MINOR, reason: "涉及未成年人",
        });
      }
      if (flags.sensitiveGeo) {
        await this.#emit("REVIEW_REQUESTED", "media_clip", payload.clipId, `敏感位置复核：${payload.clipId}`, {
          clipId: payload.clipId, role: REVIEW_ROLES.GEO, reason: "包含受限地理信息",
        });
      }
      if (payload.replaces) {
        await this.#emit("CLIP_REPLACED", "work", payload.workId, `片段替换：${payload.replaces} → ${payload.clipId}`, {
          workId: payload.workId, oldClipId: payload.replaces, newClipId: payload.clipId,
        });
      }
    }
    if (event.event_type === "CREDENTIAL_SUBMITTED") {
      await this.#jobs.add({ type: "VERIFY_CREDENTIAL", credentialId: payload.credentialId });
    }
    const withdrawal = WITHDRAWAL_EVENTS[event.event_type];
    if (withdrawal) await this.#afterWithdrawal(event, withdrawal);
  }

  // 内容摘要相同只提示关联，不自动合并。
  async #suggestAssociations(event) {
    const digest = event.payload?.digest;
    if (!digest) return;
    const group = [...(this.#state.digestIndex.get(digest) ?? [])];
    if (group.length < 2) return;
    const pending = [...this.#state.suggestions.values()].some(
      (suggestion) => suggestion.digest === digest && suggestion.status === "pending",
    );
    if (pending) return;
    const suggestionId = `sug-${sha256(digest).slice(0, 12)}`;
    await this.#emit("ASSOCIATION_SUGGESTED", "association", suggestionId, `内容摘要相同，提示关联：${group.join("、")}`, {
      suggestionId, digest, entityIds: group,
    });
  }

  // 撤回只阻止之后的新使用；已经发生的合规发布追加处置记录并通知相关方。
  async #afterWithdrawal(event, { idField }) {
    const id = event.payload[idField];
    const cause = event.event_type;
    for (const publication of this.#state.publications.values()) {
      if (publication.status !== "published") continue;
      const referenced = publication.basis.decisions.some((decision) =>
        cause === "CONSENT_WITHDRAWN"
          ? decision.consent.consentIds.includes(id)
          : decision.copyright.credentialIds.includes(id),
      );
      if (!referenced) continue;
      await this.#emit("DISPOSITION_RECORDED", "publication", publication.id, `撤回处置记录：${publication.id}`, {
        publicationId: publication.id,
        cause,
        subject: id,
        detail: "撤回仅阻止之后的新使用；该发布依据冻结时合规，保留原依据并追加处置记录",
      });
      await this.#jobs.add({ type: "NOTIFY_WITHDRAWAL", subject: id, cause, publicationId: publication.id });
    }
  }

  #fold(event) {
    const state = this.#state;
    const payload = event.payload ?? {};
    switch (event.event_type) {
      case "WORK_REGISTERED":
        this.#registerEntity({
          id: payload.workId, kind: "work", digest: payload.digest ?? null,
          submissionId: payload.submissionId ?? null, title: payload.title ?? "", parentIds: [],
        });
        break;
      case "CLIP_REGISTERED":
        this.#registerEntity({
          id: payload.clipId, kind: "media_clip", digest: payload.digest ?? null,
          submissionId: payload.submissionId ?? null, workId: payload.workId,
          flags: payload.flags ?? {}, requiresConsent: Boolean(payload.requiresConsent),
          blockedTerritories: payload.blockedTerritories ?? [],
          parentIds: payload.replaces ? [payload.replaces] : [],
        });
        break;
      case "DECLARATION_SUBMITTED":
        this.#registerEntity({
          id: payload.declarationId, kind: "declaration", digest: payload.digest ?? null,
          submissionId: payload.submissionId ?? null, workId: payload.workId ?? null,
          dtype: payload.dtype ?? "OWNERSHIP", clipIds: payload.clipIds ?? [],
          status: "active", parentIds: [],
        });
        break;
      case "CREDENTIAL_SUBMITTED":
        this.#registerEntity({
          id: payload.credentialId, kind: "rights_credential", digest: payload.digest ?? null,
          submissionId: payload.submissionId ?? null, workId: payload.workId ?? null,
          clipIds: payload.clipIds ?? [], partner: payload.partner ?? "未知合作方",
          scope: { purposes: payload.scope?.purposes ?? [], territories: payload.scope?.territories ?? [] },
          validFrom: payload.validFrom ?? null, validTo: payload.validTo ?? null,
          confirmed: false, status: "active", parentIds: [],
        });
        break;
      case "REDACTION_REGISTERED":
        this.#registerEntity({
          id: payload.redactionId, kind: "redacted_variant", digest: payload.digest ?? null,
          submissionId: payload.submissionId ?? null, workId: payload.workId ?? null,
          sourceClipId: payload.sourceClipId ?? null, method: payload.method ?? "blur",
          parentIds: payload.sourceClipId ? [payload.sourceClipId] : [],
        });
        break;
      case "ASSOCIATION_SUGGESTED":
        state.suggestions.set(payload.suggestionId, {
          id: payload.suggestionId, digest: payload.digest,
          entityIds: [...payload.entityIds], status: "pending",
        });
        break;
      case "MERGE_DECIDED": {
        const suggestion = state.suggestions.get(payload.suggestionId);
        if (suggestion) {
          suggestion.status = payload.merge ? "merged" : "dismissed";
          suggestion.decidedBy = payload.editor ?? null;
          if (payload.merge) {
            for (const id of suggestion.entityIds) {
              const entity = state.entities.get(id);
              if (entity) entity.mergedWith = suggestion.entityIds.filter((other) => other !== id);
            }
          }
        }
        break;
      }
      case "CLIP_REPLACED":
        state.replacements.push({
          workId: payload.workId, oldClipId: payload.oldClipId,
          newClipId: payload.newClipId, at: event.occurred_at,
        });
        break;
      case "REVIEW_REQUESTED": {
        if (!state.reviews.has(payload.clipId)) state.reviews.set(payload.clipId, new Map());
        state.reviews.get(payload.clipId).set(payload.role, {
          status: "pending", reason: payload.reason ?? "", requestedAt: event.occurred_at,
        });
        break;
      }
      case "REVIEW_RESOLVED": {
        const review = state.reviews.get(payload.clipId)?.get(payload.role);
        if (review) {
          Object.assign(review, {
            status: payload.approved ? "approved" : "rejected",
            reviewer: payload.reviewer ?? null, resolvedAt: event.occurred_at,
          });
        }
        break;
      }
      case "BASIS_FROZEN":
        state.publications.set(payload.publicationId, {
          id: payload.publicationId, workId: payload.workId,
          purpose: payload.purpose, territory: payload.territory,
          editor: payload.editor ?? null, basis: payload.basis,
          status: "frozen", dispositions: [],
        });
        break;
      case "VARIANT_PUBLISHED": {
        const publication = state.publications.get(payload.publicationId);
        if (publication) {
          publication.status = "published";
          publication.publishedAt = event.occurred_at;
        }
        break;
      }
      case "PUBLICATION_REJECTED": {
        const publication = state.publications.get(payload.publicationId);
        if (publication) {
          publication.status = "rejected";
          publication.rejectionReasons = payload.reasons ?? [];
        }
        break;
      }
      case "DISPOSITION_RECORDED": {
        const publication = state.publications.get(payload.publicationId);
        if (publication) {
          publication.dispositions.push({
            cause: payload.cause, subject: payload.subject,
            detail: payload.detail, at: event.occurred_at,
          });
        }
        break;
      }
      case "CREDENTIAL_CONFIRMED": {
        const credential = state.entities.get(payload.credentialId);
        if (credential) credential.confirmed = true;
        break;
      }
      case "CONSENT_WITHDRAWN":
      case "CREDENTIAL_WITHDRAWN": {
        const id = payload.declarationId ?? payload.credentialId;
        const entity = state.entities.get(id);
        if (entity) {
          entity.status = "withdrawn";
          entity.withdrawnAt = event.occurred_at;
        }
        break;
      }
      case "RECORD_QUARANTINED":
        state.quarantine.push({
          conflictingId: payload.conflictingId,
          existingDigest: payload.existingDigest ?? null,
          incoming: payload.incoming,
          at: event.occurred_at,
        });
        break;
      default:
        break;
    }
  }

  #registerEntity(entity) {
    entity.mergedWith = [];
    this.#state.entities.set(entity.id, entity);
    if (entity.digest) {
      if (!this.#state.digestIndex.has(entity.digest)) this.#state.digestIndex.set(entity.digest, new Set());
      this.#state.digestIndex.get(entity.digest).add(entity.id);
    }
  }

  async #persistRequests() {
    if (!this.#requestsPath) return;
    await mkdir(path.dirname(this.#requestsPath), { recursive: true });
    await writeFile(this.#requestsPath, JSON.stringify(Object.fromEntries(this.#requests), null, 2), "utf8");
  }
}

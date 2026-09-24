// 系统装配：命令分发 + 投影维护 + 通知 outbox + 崩溃恢复。
//
// 恢复语义：服务重启后调用 recover()，
// - 投递失败/未投递的 outbox 通知继续重试（撤回通知不丢）；
// - 仍处于 pending 的复核任务重新出现在待办中（核验继续推进）。

import { EventStore } from "./store.js";
import { applyEvent, buildModel, emptyModel, pendingVerifications, relatedWorks, workOf } from "./projections.js";
import * as domain from "./domain.js";

const COMMANDS = {
  intake_batch: domain.intakeBatch,
  decide_verification: domain.decideVerification,
  confirm_partner: domain.confirmPartner,
  add_credential: domain.addCredential,
  freeze_basis: domain.freezeBasis,
  release_publication: domain.releasePublication,
  withdraw_consent: domain.withdrawConsent,
  replace_clip: domain.replaceClip,
  merge_works: domain.mergeWorks,
  resolve_quarantine: domain.resolveQuarantine,
};

export class IntakeService {
  #store;
  #deliver; // 通知投递器：async (message) => void，抛错视为投递失败
  #model;
  #maxAttempts;

  constructor({ store, deliver, maxAttempts = 5 } = {}) {
    this.#store = store;
    this.#deliver = deliver ?? (async () => {});
    this.#maxAttempts = maxAttempts;
    this.#model = null;
  }

  static async open({ filePath, deliver, maxAttempts } = {}) {
    const store = await new EventStore(filePath).load();
    const service = new IntakeService({ store, deliver, maxAttempts });
    service.#model = buildModel(store.events);
    return service;
  }

  get model() {
    return this.#model;
  }

  // 只读事件日志（诊断与测试用；事件不可变，返回副本）。
  get events() {
    return structuredClone(this.#store.events);
  }

  // 统一入口：同一 request_id 重放返回首次结果，不重复执行。
  async dispatch(command, payload = {}, { requestId = null, now = new Date().toISOString() } = {}) {
    const handler = COMMANDS[command];
    if (!handler) throw new Error(`未知命令：${command}`);
    const committed = await this.#store.withRequest(requestId, async () => {
      const { events, outbox, result } = handler(this.#model, payload, { requestId, now });
      return { events, outbox, result };
    });
    if (!committed.replayed) {
      for (const event of committed.events) applyEvent(this.#model, event);
      await this.#pumpOutbox();
    }
    return committed.result;
  }

  // 崩溃/重启后的恢复：续投未完成的通知，报告仍在等待的复核。
  async recover() {
    this.#model = buildModel(this.#store.events); // 从日志重建，确保一致
    const delivered = await this.#pumpOutbox({ force: true }); // 重启即重投，不等退避
    return {
      redelivered: delivered,
      pending_verifications: pendingVerifications(this.#model).map((v) => ({
        verification_id: v.verification_id,
        work_id: v.work_id,
        clip_id: v.clip_id,
        kind: v.kind,
        assignee_role: v.assignee_role,
      })),
    };
  }

  async #pumpOutbox({ force = false } = {}) {
    const delivered = [];
    const due = force
      ? this.#store.state.outbox.filter((m) => m.status === "pending").map((m) => structuredClone(m))
      : this.#store.pendingOutbox();
    for (const message of due) {
      try {
        await this.#deliver(message);
        await this.#store.updateOutbox(message.message_id, { status: "delivered", delivered_at: new Date().toISOString() });
        delivered.push(message.message_id);
      } catch (err) {
        const attempts = (message.attempts ?? 0) + 1;
        await this.#store.updateOutbox(message.message_id, {
          attempts,
          status: attempts >= this.#maxAttempts ? "failed" : "pending",
          last_error: String(err?.message ?? err),
          // 简单退避：按尝试次数推迟下次投递。
          deliver_after: Date.now() + attempts * 1000,
        });
      }
    }
    return delivered;
  }

  // ---- 查询 ----

  workLineage(workId) {
    const work = workOf(this.#model, workId);
    return {
      work: structuredClone(work),
      clips: work.clip_ids.map((id) => structuredClone(this.#model.clips.get(id))).filter(Boolean),
      declarations: work.declaration_ids.map((id) => structuredClone(this.#model.declarations.get(id))).filter(Boolean),
      credentials: work.credential_ids.map((id) => structuredClone(this.#model.credentials.get(id))).filter(Boolean),
      variants: work.variant_ids.map((id) => structuredClone(this.#model.variants.get(id))).filter(Boolean),
      related: relatedWorks(this.#model, workId),
      quarantine: this.#model.quarantine.get(workId) ?? null,
    };
  }

  // 打开任一成片：说明它为何获准、替换过哪些片段、哪些合作方尚未确认。
  explainPublication(publicationId) {
    const pub = this.#model.publications.get(publicationId);
    if (!pub) throw new Error(`成片不存在：${publicationId}`);
    const basis = this.#model.bases.get(pub.basis_id);
    const work = this.#model.works.get(pub.work_id);
    // 冻结依据不变，但「尚未确认」按当前状态回答：迟到确认会改变这里的答案。
    const unconfirmedPartners = (basis?.snapshot.credentials ?? [])
      .filter((c) => c.partner)
      .filter((c) => this.#model.credentials.get(c.credential_id)?.partner_confirmed !== true)
      .map((c) => ({ credential_id: c.credential_id, partner: c.partner }));
    return {
      publication_id: pub.publication_id,
      work_id: pub.work_id,
      purpose: pub.purpose,
      released_at: pub.released_at,
      approved_because: {
        basis_id: basis?.basis_id,
        frozen_at: basis?.frozen_at,
        credentials: basis?.snapshot.credentials ?? [],
        consent: basis?.snapshot.consent ?? [],
        geo_restricted_clips: basis?.snapshot.geo_restricted_clips ?? [],
      },
      replaced_clips: structuredClone(work?.replaced_clips ?? []),
      unconfirmed_partners: unconfirmedPartners,
      post_publication_actions: structuredClone(pub.post_actions),
    };
  }

  pendingOutbox() {
    // 所有尚未投递成功的通知（含退避中的），用于诊断与测试。
    return this.#store.state.outbox.filter((m) => m.status === "pending").map((m) => structuredClone(m));
  }
}

export { emptyModel };

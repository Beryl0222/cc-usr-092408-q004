import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { IntakeService } from "../src/system.js";

// 每个用例一个独立临时库文件；deliver 默认记录到数组便于断言。
export async function makeService({ deliver, maxAttempts } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "yellow-river-intake-"));
  const delivered = [];
  const service = await IntakeService.open({
    filePath: path.join(dir, "events.json"),
    deliver: deliver ?? (async (m) => delivered.push(m)),
    maxAttempts,
  });
  return {
    service,
    delivered,
    filePath: path.join(dir, "events.json"),
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function clip(overrides = {}) {
  return {
    clip_id: overrides.clip_id ?? "clip-1",
    kind: "footage",
    label: "黄河航拍",
    has_minor: false,
    has_sensitive_geo: false,
    consent_scope: "granted",
    ...overrides,
  };
}

export function submission(overrides = {}) {
  const workId = overrides.workId ?? "work-1";
  return {
    submission_id: overrides.submission_id ?? `sub-${workId}`,
    work: {
      work_id: workId,
      title: overrides.title ?? "黄河航拍成片",
      content_summary: overrides.content_summary ?? `航拍摘要-${workId}`,
      submitter: overrides.submitter ?? "投稿人甲",
      clips: overrides.clips ?? [clip({ clip_id: `${workId}-c1` })],
      declarations: overrides.declarations ?? [
        { declaration_id: `${workId}-d1`, statement: "本人原创，同意授权" },
      ],
      credentials: overrides.credentials ?? [
        {
          credential_id: `${workId}-lic`,
          credential_type: "license",
          scope: ["web", "broadcast"],
          valid_from: "2026-01-01T00:00:00+08:00",
          valid_until: "2027-01-01T00:00:00+08:00",
        },
      ],
      variants: overrides.variants ?? [],
    },
  };
}

// 把作品推进到「可冻结」状态：完成全部复核。
export async function clearVerifications(service, workId) {
  const pending = service.model
    ? [...service.model.verifications.values()].filter((v) => v.work_id === workId && v.status === "pending")
    : [];
  for (const v of pending) {
    await service.dispatch("decide_verification", { verification_id: v.verification_id, decision: "approved" });
  }
}

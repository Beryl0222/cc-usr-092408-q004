const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) errors.push("version 必须是正整数");
  return errors;
}

// 投稿记录的基础校验：入库前的第一道关（坏记录在此被挑出，不影响同批其余作品）。
export function validateSubmissionRecord(record) {
  const errors = [];
  if (!record || typeof record !== "object") return ["记录不是对象"];
  if (!record.submission_id) errors.push("缺少字段：submission_id");
  if (!record.work?.work_id) errors.push("缺少字段：work.work_id");
  if (!record.work?.content_summary && !record.work?.content_digest) errors.push("缺少内容摘要");
  for (const [index, clip] of (record.work?.clips ?? []).entries()) {
    if (!clip.clip_id) errors.push(`第 ${index + 1} 个片段缺少 clip_id`);
  }
  return errors;
}

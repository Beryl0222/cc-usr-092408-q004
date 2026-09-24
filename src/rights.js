// 权利评估的纯函数：给定片段、授权凭证、人物同意与发布用途，
// 计算某一时刻该片段在版权、人物同意、地域三个维度上是否可用。
// 评估结果会被冻结进发布依据，之后的授权变化不影响已冻结的结论。

const toTime = (iso) => Date.parse(iso);

export function coversClip(credential, clip) {
  if (credential.clipIds?.length) return credential.clipIds.includes(clip.id);
  return credential.workId === clip.workId;
}

export function credentialActiveAt(credential, at) {
  if (credential.status !== "active") return false;
  if (!credential.confirmed) return false;
  const t = toTime(at);
  if (credential.validFrom && toTime(credential.validFrom) > t) return false;
  if (credential.validTo && toTime(credential.validTo) < t) return false;
  return true;
}

export function evaluateCopyright({ clip, credentials, purpose, territory, at }) {
  const covering = credentials.filter((credential) => coversClip(credential, clip));
  const usable = covering.filter(
    (credential) =>
      credentialActiveAt(credential, at) &&
      credential.scope.purposes.includes(purpose) &&
      (credential.scope.territories.includes("*") || credential.scope.territories.includes(territory)),
  );
  if (usable.length > 0) {
    return { ok: true, credentialIds: usable.map((credential) => credential.id) };
  }
  let reason = "缺少覆盖该片段的有效授权";
  if (covering.some((credential) => credential.status === "withdrawn")) {
    reason = "授权已被撤回";
  } else if (covering.some((credential) => credential.status === "active" && !credential.confirmed)) {
    reason = "授权尚未确认";
  } else if (covering.length > 0) {
    reason = "授权范围不覆盖该用途或地域";
  }
  return { ok: false, credentialIds: [], reason };
}

export function evaluateConsent({ clip, consents }) {
  if (!clip.requiresConsent) return { ok: true, consentIds: [] };
  const covering = consents.filter((consent) => consent.clipIds.includes(clip.id));
  const active = covering.filter((consent) => consent.status === "active");
  if (active.length > 0) {
    return { ok: true, consentIds: active.map((consent) => consent.id) };
  }
  const withdrawn = covering.some((consent) => consent.status === "withdrawn");
  return { ok: false, consentIds: [], reason: withdrawn ? "人物同意已被撤回" : "缺少人物肖像同意" };
}

export function evaluateGeo({ clip, territory }) {
  const blocked = clip.blockedTerritories ?? [];
  if (blocked.includes(territory)) {
    return { ok: false, reason: `地域受限：${territory}` };
  }
  return { ok: true };
}

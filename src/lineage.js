// 谱系投影的纯函数：从折叠后的事件状态推导作品的当前片段与替换链。

// 作品当前可用的片段：被替换掉的原始片段不再参与发布评估，
// 但仍保留在谱系中，供成片说明"替换过哪些片段"。
export function currentClipsOf(state, workId) {
  const replaced = new Set(
    state.replacements.filter((item) => item.workId === workId).map((item) => item.oldClipId),
  );
  return [...state.entities.values()].filter(
    (entity) => entity.kind === "media_clip" && entity.workId === workId && !replaced.has(entity.id),
  );
}

// 片段替换链：按发生顺序列出每一次替换。
export function replacementChainsOf(state, workId) {
  return state.replacements
    .filter((item) => item.workId === workId)
    .map((item) => ({ from: item.oldClipId, to: item.newClipId, at: item.at }));
}

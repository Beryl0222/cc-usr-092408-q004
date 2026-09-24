# 黄河影像征集核验

面向影像征集编辑部的投稿入库与权利核验服务。同一批黄河航拍可能收到多个投稿版本：补交授权、撤回肖像同意、初审后才发现受限地理信息——系统不再靠文件名判断哪一版可公开，而是用事件谱系和冻结的发布依据说话。

## 领域边界

事件一旦被接收，其标识、发生时间和版本不应被原地改写；业务更正应产生后继记录。涉及个人、机构或商业敏感信息时，调用方只读取完成职责所必需的字段。

## 核心语义

- **谱系拆分**：投稿入库即拆出作品、素材片段、投稿人声明、权利凭证、脱敏版本各自的聚合与事件（`WORK_REGISTERED` / `CLIP_REGISTERED` / `DECLARATION_RECORDED` / `CREDENTIAL_RECORDED` / `SANITIZED_VARIANT_CREATED`）。
- **关联不合并**：内容摘要相同只产生 `WORKS_ASSOCIATED` 提示，是否合并由编辑调用 `merge_works` 决定；编号相同而摘要不同则 `WORK_QUARANTINED` 隔离待查。
- **分角色复核**：含未成年人的片段分派 `minor_protection_reviewer`，含敏感地理位置的分派 `geo_compliance_reviewer`，版权与肖像同意另有对应角色；全部通过后记 `RIGHTS_CLEARED`。
- **冻结发布依据**：编辑选定发布用途时，`freeze_basis` 把当时有效的版权范围、人物同意、地域限制打成快照（`PUBLICATION_BASIS_FROZEN`）。迟到授权与并发入库都不能改写已冻结的依据。
- **撤回语义**：`withdraw_consent` 只阻止之后的新使用；已经发生的合规发布追加 `POST_PUBLICATION_ACTION_APPENDED` 处置记录并通知，不追溯作废。
- **批量容错**：一批投稿中混有坏记录时，坏记录进 `rejected`，其余作品正常入库。
- **幂等与恢复**：同一 `request_id` 重放返回首次结果，不重复执行；服务重启后 `recover()` 续投未送达的通知（含撤回通知），并重新列出未完成的复核任务。
- **成片溯源**：`explainPublication` 回答任一成片为何获准（冻结依据）、替换过哪些片段、哪些合作方尚未确认。

## 代码结构

- `contracts/domain.schema.json`：领域事件信封与事件/聚合枚举的契约。
- `src/events.js`：事件类型、聚合类型、复核角色常量与事件构造。
- `src/store.js`：单文件原子提交的事件存储；只追加日志 + 请求幂等台账 + 通知 outbox。
- `src/projections.js`：把事件折叠成读模型（可丢弃重建）。
- `src/domain.js`：领域决策纯函数（入库、复核、冻结、发布、撤回、替换、合并、隔离）。
- `src/system.js`：命令分发、投影维护、outbox 投递与崩溃恢复、成片溯源查询。
- `data/sample.json`：单条事件样例；`data/batch.sample.json`：含好/坏记录的批量投稿样例。
- `tests/`：入库、权利、恢复、溯源、并发、契约六组场景测试。

## 本地检查

```bash
npm test        # node --test
npm run build   # 对 src/ 全部文件做语法检查
```

上述命令均可在单个 Linux 应用容器内执行，不需要另行启动外部服务。

## 用法示例

```js
import { IntakeService } from "./src/index.js";

const service = await IntakeService.open({
  filePath: "data/events.json",
  deliver: async (notice) => {/* 投递核验分派/撤回通知 */},
});

await service.dispatch("intake_batch", batch, { requestId: "req-001" });
await service.dispatch("decide_verification", { verification_id, decision: "approved" });
const { basis_id } = await service.dispatch("freeze_basis", { work_id, purpose: "web" });
await service.dispatch("release_publication", { work_id, basis_id });
const explain = service.explainPublication(publication_id);
```

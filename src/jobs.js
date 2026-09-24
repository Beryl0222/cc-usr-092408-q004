import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// 待办任务日志：授权核验、撤回通知等异步职责在此登记。
// 服务中断后重新打开时，未完成的任务保持 pending，由 resume 继续推进。
export class JobJournal {
  #path;
  #jobs = [];

  constructor(filePath) {
    this.#path = filePath;
  }

  static async open(filePath = null) {
    const journal = new JobJournal(filePath);
    if (filePath && existsSync(filePath)) {
      journal.#jobs = JSON.parse(await readFile(filePath, "utf8"));
    }
    return journal;
  }

  async add(job) {
    const record = { id: `job-${randomUUID()}`, status: "pending", ...job };
    this.#jobs.push(record);
    await this.#persist();
    return record;
  }

  pending() {
    return this.#jobs.filter((job) => job.status === "pending");
  }

  async complete(id) {
    const job = this.#jobs.find((item) => item.id === id);
    if (job && job.status !== "done") {
      job.status = "done";
      await this.#persist();
    }
  }

  async #persist() {
    if (!this.#path) return;
    await mkdir(path.dirname(this.#path), { recursive: true });
    await writeFile(this.#path, JSON.stringify(this.#jobs, null, 2), "utf8");
  }
}

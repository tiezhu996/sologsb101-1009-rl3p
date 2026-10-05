/**
 * 乐观并发冲突：行版本号与提交方持有的 baseRevision 不一致时抛出。
 * 调用方捕获后应把完整载荷转入「待合并」队列，而不是覆盖先写入者的数据。
 */
export class RevisionConflictError extends Error {
  /** 提交方持有的版本 */
  baseRevision: number
  /** 库中实际版本 */
  currentRevision: number

  constructor(baseRevision: number, currentRevision: number, message?: string) {
    super(message ?? `数据已被其他标签页修改（基准版本 ${baseRevision}，当前版本 ${currentRevision}）`)
    this.name = 'RevisionConflictError'
    this.baseRevision = baseRevision
    this.currentRevision = currentRevision
  }
}

export function isRevisionConflictError(error: unknown): error is RevisionConflictError {
  return error instanceof RevisionConflictError
}

/** 乐观提交的统一结果 */
export type CommitOutcome<T> =
  | { ok: true; data: T; revision: number }
  | { ok: false; conflict: true; baseRevision: number; currentRevision: number }

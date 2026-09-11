interface ScheduledTask {
  fileUri: string;
  work: (signal: AbortSignal) => Promise<unknown>;
  controller: AbortController;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
  externalSignal?: AbortSignal;
  abortListener?: () => void;
}

const DEFAULT_MAX_CONCURRENT = 10;
const MAX_CONCURRENT_LIMIT = 64;

function abortError(message = 'Translation request cancelled.'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/** Shares request concurrency across all files and rotates waiting files fairly. */
export class FileScheduler {
  private readonly queues = new Map<string, ScheduledTask[]>();
  private readonly active = new Set<ScheduledTask>();
  private maxConcurrent: number;
  private disposed = false;
  private draining = false;

  /** Creates a scheduler with a global request concurrency limit from 1 to 64. */
  public constructor(maxConcurrent: number = DEFAULT_MAX_CONCURRENT) {
    this.validateMaxConcurrent(maxConcurrent);
    this.maxConcurrent = maxConcurrent;
  }

  /** Updates the limit immediately while allowing excess running requests to finish. */
  public setMaxConcurrent(maxConcurrent: number): void {
    this.validateMaxConcurrent(maxConcurrent);
    this.maxConcurrent = maxConcurrent;
    this.drain();
  }

  /** Queues work; cancellation rejects promptly but retains its slot until running work exits. */
  public schedule<T>(
    fileUri: string,
    work: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(abortError('Translation scheduler has been disposed.'));
    }
    if (signal?.aborted) {
      return Promise.reject(abortError());
    }

    const promise = new Promise<T>((resolve, reject) => {
      const task: ScheduledTask = {
        fileUri,
        work,
        controller: new AbortController(),
        resolve: (value) => resolve(value as T),
        reject,
        settled: false,
        ...(signal ? { externalSignal: signal } : {})
      };
      const queue = this.queues.get(fileUri) ?? [];
      queue.push(task);
      this.queues.set(fileUri, queue);

      if (signal) {
        task.abortListener = () => this.cancelTask(task);
        signal.addEventListener('abort', task.abortListener, { once: true });
      }
      this.drain();
    });
    return promise;
  }

  /** Rejects this file's queued tasks and signals all its running requests to stop. */
  public cancel(fileUri: string): void {
    const tasks = [
      ...(this.queues.get(fileUri) ?? []),
      ...[...this.active].filter((task) => task.fileUri === fileUri)
    ];
    this.queues.delete(fileUri);
    for (const task of tasks) {
      this.rejectTask(task, abortError());
      task.controller.abort();
    }
    this.drain();
  }

  /** Cancels outstanding work and permanently rejects new scheduling attempts. */
  public dispose(): void {
    this.disposed = true;
    for (const fileUri of new Set([
      ...this.queues.keys(),
      ...[...this.active].map((task) => task.fileUri)
    ])) {
      this.cancel(fileUri);
    }
  }

  private validateMaxConcurrent(maxConcurrent: number): void {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > MAX_CONCURRENT_LIMIT) {
      throw new RangeError('Maximum concurrency must be an integer from 1 to 64.');
    }
  }

  private cancelTask(task: ScheduledTask): void {
    if (task.settled) {
      return;
    }
    const queue = this.queues.get(task.fileUri);
    const taskIndex = queue?.indexOf(task) ?? -1;
    if (queue && taskIndex >= 0) {
      queue.splice(taskIndex, 1);
      if (queue.length === 0) {
        this.queues.delete(task.fileUri);
      }
    }
    this.rejectTask(task, abortError());
    task.controller.abort();
    this.drain();
  }

  private drain(): void {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (!this.disposed && this.active.size < this.maxConcurrent) {
        let nextTask: ScheduledTask | undefined;
        for (const [fileUri, queue] of this.queues) {
          nextTask = queue.shift();
          this.queues.delete(fileUri);
          if (queue.length > 0) {
            // Rotate a serviced file to the back so other files are not starved.
            this.queues.set(fileUri, queue);
          }
          break;
        }
        if (!nextTask) {
          return;
        }
        this.active.add(nextTask);
        void this.executeTask(nextTask);
      }
    } finally {
      this.draining = false;
    }
  }

  private async executeTask(task: ScheduledTask): Promise<void> {
    try {
      const value = await task.work(task.controller.signal);
      if (!task.settled) {
        task.settled = true;
        this.removeAbortListener(task);
        task.resolve(value);
      }
    } catch (error) {
      this.rejectTask(task, error);
    } finally {
      this.removeAbortListener(task);
      this.active.delete(task);
      this.drain();
    }
  }

  private rejectTask(task: ScheduledTask, reason: unknown): void {
    if (task.settled) {
      return;
    }
    task.settled = true;
    this.removeAbortListener(task);
    task.reject(reason);
  }

  private removeAbortListener(task: ScheduledTask): void {
    if (task.externalSignal && task.abortListener) {
      task.externalSignal.removeEventListener('abort', task.abortListener);
    }
  }
}

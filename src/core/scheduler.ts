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

const DEFAULT_MAX_CONCURRENT = 3;

function abortError(message = 'Translation request cancelled.'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/** Serializes each file's requests while bounding active work across all files. */
export class FileScheduler {
  private readonly queues = new Map<string, ScheduledTask[]>();
  private readonly active = new Map<string, ScheduledTask>();
  private disposed = false;

  /** Creates a scheduler with the specified positive global concurrency limit. */
  public constructor(private readonly maxConcurrent: number = DEFAULT_MAX_CONCURRENT) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
      throw new RangeError('Maximum concurrency must be a positive integer.');
    }
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

  /** Rejects this file's queued tasks and signals any running task to stop. */
  public cancel(fileUri: string): void {
    const queue = this.queues.get(fileUri);
    this.queues.delete(fileUri);
    for (const task of queue ?? []) {
      this.rejectTask(task, abortError());
      task.controller.abort();
    }
    const runningTask = this.active.get(fileUri);
    if (runningTask) {
      this.rejectTask(runningTask, abortError());
      runningTask.controller.abort();
    }
    this.drain();
  }

  /** Cancels outstanding work and permanently rejects new scheduling attempts. */
  public dispose(): void {
    this.disposed = true;
    for (const fileUri of new Set([...this.queues.keys(), ...this.active.keys()])) {
      this.cancel(fileUri);
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
    while (!this.disposed && this.active.size < this.maxConcurrent) {
      let nextTask: ScheduledTask | undefined;
      for (const [fileUri, queue] of this.queues) {
        if (this.active.has(fileUri)) {
          continue;
        }
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
      this.active.set(nextTask.fileUri, nextTask);
      void this.executeTask(nextTask);
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
      this.active.delete(task.fileUri);
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

import { describe, expect, it, vi } from 'vitest';
import { FileScheduler } from '../src/core/scheduler';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('FileScheduler', () => {
  it('runs at most three files concurrently by default', async () => {
    const scheduler = new FileScheduler();
    const gates = Array.from({ length: 5 }, () => deferred<number>());
    const started: number[] = [];
    let active = 0;
    let maximumActive = 0;
    const promises = gates.map((gate, index) =>
      scheduler.schedule(`file:${index}`, async () => {
        started.push(index);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          return await gate.promise;
        } finally {
          active -= 1;
        }
      })
    );
    expect(started).toEqual([0, 1, 2]);
    gates[0]!.resolve(0);
    await promises[0];
    expect(started).toEqual([0, 1, 2, 3]);
    gates[1]!.resolve(1);
    await promises[1];
    expect(started).toEqual([0, 1, 2, 3, 4]);
    gates.slice(2).forEach((gate, index) => gate.resolve(index + 2));
    expect(await Promise.all(promises)).toEqual([0, 1, 2, 3, 4]);
    expect(maximumActive).toBe(3);
  });

  it('preserves file order while allowing another file to run independently', async () => {
    const scheduler = new FileScheduler(3);
    const firstGate = deferred<string>();
    const secondGate = deferred<string>();
    const otherGate = deferred<string>();
    const started: string[] = [];
    const first = scheduler.schedule('file:a', () => {
      started.push('a:1');
      return firstGate.promise;
    });
    const second = scheduler.schedule('file:a', () => {
      started.push('a:2');
      return secondGate.promise;
    });
    const other = scheduler.schedule('file:b', () => {
      started.push('b:1');
      return otherGate.promise;
    });
    expect(started).toEqual(['a:1', 'b:1']);
    firstGate.resolve('first');
    await first;
    expect(started).toEqual(['a:1', 'b:1', 'a:2']);
    secondGate.resolve('second');
    otherGate.resolve('other');
    expect(await Promise.all([first, second, other])).toEqual(['first', 'second', 'other']);
  });

  it('cancels queued and running file work without releasing a running slot early', async () => {
    const scheduler = new FileScheduler(1);
    const gate = deferred<string>();
    let runningSignal: AbortSignal | undefined;
    const running = scheduler.schedule('file:a', (signal) => {
      runningSignal = signal;
      return gate.promise;
    }).catch((error: unknown) => error);
    const queuedWork = vi.fn(async () => 'should not run');
    const queued = scheduler.schedule('file:a', queuedWork).catch((error: unknown) => error);
    const otherWork = vi.fn(async () => 'other');
    const other = scheduler.schedule('file:b', otherWork);

    scheduler.cancel('file:a');
    expect(runningSignal?.aborted).toBe(true);
    expect(await running).toMatchObject({ name: 'AbortError' });
    expect(await queued).toMatchObject({ name: 'AbortError' });
    expect(queuedWork).not.toHaveBeenCalled();
    expect(otherWork).not.toHaveBeenCalled();

    gate.resolve('ignored late response');
    expect(await other).toBe('other');
    expect(otherWork).toHaveBeenCalledOnce();
    expect(await scheduler.schedule('file:a', async () => 'restart')).toBe('restart');
  });

  it('cancels an individual queued request promptly without cancelling its file siblings', async () => {
    const scheduler = new FileScheduler(1);
    const gate = deferred<string>();
    const first = scheduler.schedule('file:a', () => gate.promise);
    const controller = new AbortController();
    const cancelledWork = vi.fn(async () => 'cancelled');
    const cancelled = scheduler.schedule('file:a', cancelledWork, controller.signal)
      .catch((error: unknown) => error);
    const sibling = scheduler.schedule('file:a', async () => 'sibling');
    controller.abort();
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    expect(cancelledWork).not.toHaveBeenCalled();
    gate.resolve('first');
    expect(await first).toBe('first');
    expect(await sibling).toBe('sibling');
  });

  it('holds the concurrency slot until externally aborted work actually rejects', async () => {
    const scheduler = new FileScheduler(1);
    const gate = deferred<string>();
    const controller = new AbortController();
    let runningSignal: AbortSignal | undefined;
    const cancelled = scheduler.schedule('file:a', (signal) => {
      runningSignal = signal;
      return gate.promise;
    }, controller.signal).catch((error: unknown) => error);
    const nextWork = vi.fn(async () => 'next');
    const next = scheduler.schedule('file:b', nextWork);
    controller.abort();
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    expect(runningSignal?.aborted).toBe(true);
    expect(nextWork).not.toHaveBeenCalled();
    gate.reject(new Error('Underlying transport finally stopped.'));
    expect(await next).toBe('next');
  });

  it('releases a failed request slot and continues the same file queue', async () => {
    const scheduler = new FileScheduler(1);
    const gate = deferred<string>();
    const failure = new Error('mock API failure');
    const failed = scheduler.schedule('file:a', () => gate.promise).catch((error: unknown) => error);
    const next = scheduler.schedule('file:a', async () => 'recovered');
    gate.reject(failure);
    expect(await failed).toBe(failure);
    expect(await next).toBe('recovered');
  });

  it('handles a synchronous work exception and frees the slot', async () => {
    const scheduler = new FileScheduler(1);
    const failed = scheduler.schedule('file:a', () => {
      throw new Error('synchronous failure');
    }).catch((error: unknown) => error);
    expect(await failed).toMatchObject({ message: 'synchronous failure' });
    expect(await scheduler.schedule('file:b', async () => 42)).toBe(42);
  });

  it('disposes idempotently, cancels outstanding tasks, and rejects new tasks', async () => {
    const scheduler = new FileScheduler(1);
    const gate = deferred<string>();
    const running = scheduler.schedule('file:a', () => gate.promise).catch((error: unknown) => error);
    const queuedWork = vi.fn(async () => 'queued');
    const queued = scheduler.schedule('file:b', queuedWork).catch((error: unknown) => error);
    scheduler.dispose();
    scheduler.dispose();
    expect(await running).toMatchObject({ name: 'AbortError' });
    expect(await queued).toMatchObject({ name: 'AbortError' });
    await expect(scheduler.schedule('file:c', queuedWork)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Translation scheduler has been disposed.'
    });
    gate.resolve('late result');
    await Promise.resolve();
    expect(queuedWork).not.toHaveBeenCalled();
  });

  it('rejects already-aborted input before invoking work', async () => {
    const scheduler = new FileScheduler();
    const controller = new AbortController();
    controller.abort();
    const work = vi.fn(async () => 'unused');
    await expect(scheduler.schedule('file:a', work, controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    });
    expect(work).not.toHaveBeenCalled();
    scheduler.cancel('file:unknown');
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid concurrency %s',
    (limit) => {
      expect(() => new FileScheduler(limit)).toThrow(RangeError);
    }
  );
});

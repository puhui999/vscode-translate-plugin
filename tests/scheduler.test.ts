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
  it('runs at most ten requests concurrently by default across and within files', async () => {
    const scheduler = new FileScheduler();
    const gates = Array.from({ length: 12 }, () => deferred<number>());
    const started: number[] = [];
    let active = 0;
    let maximumActive = 0;
    const promises = gates.map((gate, index) =>
      scheduler.schedule(`file:${index % 2}`, async () => {
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
    expect(started).toEqual(Array.from({ length: 10 }, (_, index) => index));
    gates[0]!.resolve(0);
    await promises[0];
    expect(started).toEqual(Array.from({ length: 11 }, (_, index) => index));
    gates[1]!.resolve(1);
    await promises[1];
    expect(started).toEqual(Array.from({ length: 12 }, (_, index) => index));
    gates.slice(2).forEach((gate, index) => gate.resolve(index + 2));
    expect(await Promise.all(promises)).toEqual(Array.from({ length: 12 }, (_, index) => index));
    expect(maximumActive).toBe(10);
  });

  it('starts consecutive requests from the same file without waiting for earlier responses', async () => {
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
    expect(started).toEqual(['a:1', 'a:2', 'b:1']);
    firstGate.resolve('first');
    await first;
    expect(started).toEqual(['a:1', 'a:2', 'b:1']);
    secondGate.resolve('second');
    otherGate.resolve('other');
    expect(await Promise.all([first, second, other])).toEqual(['first', 'second', 'other']);
  });

  it('rotates waiting files so one large file cannot consume every newly available slot', async () => {
    const scheduler = new FileScheduler(1);
    const gate = deferred<string>();
    const running = scheduler.schedule('file:a', () => gate.promise);
    const started: string[] = [];
    const ids = ['a:1', 'a:2', 'a:3', 'b:1', 'b:2', 'c:1'];
    const queued = ids.map((id) => scheduler.schedule(`file:${id[0]}`, async () => {
      started.push(id);
      return id;
    }));

    gate.resolve('initial');
    await running;
    expect(await Promise.all(queued)).toEqual(ids);
    expect(started).toEqual(['a:1', 'b:1', 'c:1', 'a:2', 'b:2', 'a:3']);
  });

  it('applies increased concurrency to queued work and lets excess running requests finish after a decrease', async () => {
    const scheduler = new FileScheduler(1);
    const gates = Array.from({ length: 5 }, () => deferred<number>());
    const started: number[] = [];
    const signals: AbortSignal[] = [];
    const promises = gates.map((gate, index) => scheduler.schedule('file:a', (signal) => {
      started.push(index);
      signals.push(signal);
      return gate.promise;
    }));
    expect(started).toEqual([0]);

    scheduler.setMaxConcurrent(3);
    expect(started).toEqual([0, 1, 2]);
    scheduler.setMaxConcurrent(1);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    gates[0]!.resolve(0);
    await promises[0];
    gates[1]!.resolve(1);
    await promises[1];
    expect(started).toEqual([0, 1, 2]);

    gates[2]!.resolve(2);
    await promises[2];
    expect(started).toEqual([0, 1, 2, 3]);
    gates[3]!.resolve(3);
    await promises[3];
    expect(started).toEqual([0, 1, 2, 3, 4]);
    gates[4]!.resolve(4);
    expect(await Promise.all(promises)).toEqual([0, 1, 2, 3, 4]);
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

  it('cancels every running request for a file while retaining each occupied slot', async () => {
    const scheduler = new FileScheduler(2);
    const gates = [deferred<string>(), deferred<string>()];
    const signals: AbortSignal[] = [];
    const running = gates.map((gate) => scheduler.schedule('file:a', (signal) => {
      signals.push(signal);
      return gate.promise;
    }).catch((error: unknown) => error));
    const queuedWork = vi.fn(async () => 'unused');
    const queued = scheduler.schedule('file:a', queuedWork).catch((error: unknown) => error);
    const otherGate = deferred<string>();
    const otherWork = vi.fn(() => otherGate.promise);
    const other = scheduler.schedule('file:b', otherWork);
    const nextWork = vi.fn(async () => 'next');
    const next = scheduler.schedule('file:c', nextWork);

    scheduler.cancel('file:a');
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(await Promise.all([...running, queued])).toEqual([
      expect.objectContaining({ name: 'AbortError' }),
      expect.objectContaining({ name: 'AbortError' }),
      expect.objectContaining({ name: 'AbortError' })
    ]);
    expect(queuedWork).not.toHaveBeenCalled();
    expect(otherWork).not.toHaveBeenCalled();
    expect(nextWork).not.toHaveBeenCalled();

    gates[0]!.resolve('late result');
    await Promise.resolve();
    expect(otherWork).toHaveBeenCalledOnce();
    expect(nextWork).not.toHaveBeenCalled();
    gates[1]!.reject(new Error('aborted transport exited'));
    expect(await next).toBe('next');
    otherGate.resolve('other');
    expect(await other).toBe('other');
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

  it('externally cancels one running request without cancelling a concurrent sibling', async () => {
    const scheduler = new FileScheduler(2);
    const cancelledGate = deferred<string>();
    const siblingGate = deferred<string>();
    const controller = new AbortController();
    let siblingSignal: AbortSignal | undefined;
    const cancelled = scheduler.schedule('file:a', () => cancelledGate.promise, controller.signal)
      .catch((error: unknown) => error);
    const sibling = scheduler.schedule('file:a', (signal) => {
      siblingSignal = signal;
      return siblingGate.promise;
    });
    const nextWork = vi.fn(async () => 'next');
    const next = scheduler.schedule('file:a', nextWork);

    controller.abort();
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    expect(siblingSignal?.aborted).toBe(false);
    expect(nextWork).not.toHaveBeenCalled();
    siblingGate.resolve('sibling');
    expect(await sibling).toBe('sibling');
    expect(await next).toBe('next');
    cancelledGate.resolve('ignored response');
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
    const scheduler = new FileScheduler(3);
    const gates = Array.from({ length: 3 }, () => deferred<string>());
    const signals: AbortSignal[] = [];
    const running = gates.map((gate) => scheduler.schedule('file:a', (signal) => {
      signals.push(signal);
      return gate.promise;
    }).catch((error: unknown) => error));
    const queuedWork = vi.fn(async () => 'queued');
    const queued = scheduler.schedule('file:b', queuedWork).catch((error: unknown) => error);
    scheduler.dispose();
    scheduler.dispose();
    expect(await Promise.all(running)).toEqual([
      expect.objectContaining({ name: 'AbortError' }),
      expect.objectContaining({ name: 'AbortError' }),
      expect.objectContaining({ name: 'AbortError' })
    ]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(await queued).toMatchObject({ name: 'AbortError' });
    await expect(scheduler.schedule('file:c', queuedWork)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Translation scheduler has been disposed.'
    });
    scheduler.setMaxConcurrent(64);
    gates.forEach((gate) => gate.resolve('late result'));
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

  it.each([0, -1, 1.5, 65, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid concurrency %s',
    (limit) => {
      expect(() => new FileScheduler(limit)).toThrow(RangeError);
      expect(() => new FileScheduler().setMaxConcurrent(limit)).toThrow(RangeError);
    }
  );

  it.each([1, 64])('accepts concurrency boundary %s', async (limit) => {
    const scheduler = new FileScheduler(limit);
    scheduler.setMaxConcurrent(limit);
    expect(await scheduler.schedule('file:a', async () => 'done')).toBe('done');
  });

  it('keeps the previous limit when a runtime update is invalid', async () => {
    const scheduler = new FileScheduler(1);
    const gate = deferred<string>();
    const running = scheduler.schedule('file:a', () => gate.promise);
    const queuedWork = vi.fn(async () => 'queued');
    const queued = scheduler.schedule('file:a', queuedWork);
    expect(() => scheduler.setMaxConcurrent(65)).toThrow(RangeError);
    expect(queuedWork).not.toHaveBeenCalled();
    gate.resolve('running');
    expect(await running).toBe('running');
    expect(await queued).toBe('queued');
  });
});

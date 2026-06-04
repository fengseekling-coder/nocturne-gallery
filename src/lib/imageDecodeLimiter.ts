/**
 * 限制同时进行中的图片解码，避免快速滚动时解码线程爆满。
 */
const MAX_CONCURRENT = 8;
let active = 0;
const queue: Array<() => void> = [];

function pump(): void {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const run = queue.shift();
    if (!run) break;
    active += 1;
    run();
  }
}

export function runWithImageDecodeSlot<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const execute = () => {
      void (async () => {
        try {
          resolve(await task());
        } catch (e) {
          reject(e);
        } finally {
          active = Math.max(0, active - 1);
          pump();
        }
      })();
    };
    queue.push(execute);
    pump();
  });
}

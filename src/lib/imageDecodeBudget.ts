/**
 * 限制同时进行的缩略图解码/升级，避免快速滚动时 CPU 与内存尖峰。
 */
const MAX_ACTIVE = 8;
let active = 0;
const queue: Array<() => void> = [];

function pump() {
  while (active < MAX_ACTIVE && queue.length > 0) {
    const job = queue.shift();
    if (!job) break;
    active += 1;
    job();
  }
}

export function scheduleThumbnailWork(run: () => void | (() => void)): () => void {
  let released = false;
  let innerCleanup: (() => void) | undefined;

  const release = () => {
    if (released) return;
    released = true;
    active = Math.max(0, active - 1);
    innerCleanup?.();
    pump();
  };

  const start = () => {
    const maybeCleanup = run();
    if (typeof maybeCleanup === 'function') {
      innerCleanup = maybeCleanup;
    }
  };

  if (active < MAX_ACTIVE) {
    active += 1;
    start();
    return release;
  }

  queue.push(() => {
    if (released) return;
    start();
  });

  return release;
}
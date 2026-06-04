/**
 * 画布滚动状态：快速滚动期间暂停网格缩略图「升档」解码。
 */
const SCROLL_IDLE_MS = 180;

type Listener = (isScrolling: boolean) => void;

let isScrolling = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

function emit(next: boolean) {
  if (next === isScrolling) return;
  isScrolling = next;
  for (const fn of listeners) fn(isScrolling);
}

export function notifyCanvasScrollActivity(): void {
  emit(true);
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    emit(false);
  }, SCROLL_IDLE_MS);
}

export function getCanvasIsScrolling(): boolean {
  return isScrolling;
}

export function subscribeCanvasScrollActivity(listener: Listener): () => void {
  listeners.add(listener);
  listener(isScrolling);
  return () => listeners.delete(listener);
}

export function waitForCanvasScrollIdle(timeoutMs = 8000): Promise<void> {
  if (!isScrolling) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(hardTimeout);
      unsub();
      resolve();
    };
    const unsub = subscribeCanvasScrollActivity((scrolling) => {
      if (!scrolling) finish();
    });
    const hardTimeout = setTimeout(finish, timeoutMs);
  });
}

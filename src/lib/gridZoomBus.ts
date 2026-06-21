/**
 * 网格列数变更后的短暂「稳定期」：暂停缩略图升档与尺寸探测，避免瀑布流被连续重算拖慢数秒。
 */
const SETTLE_MS = 720;

type Listener = (settling: boolean) => void;

let settling = false;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

function emit(next: boolean) {
  if (next === settling) return;
  settling = next;
  for (const fn of listeners) fn(settling);
}

export function notifyGridZoomActivity(): void {
  emit(true);
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    emit(false);
  }, SETTLE_MS);
}

export function getGridZoomSettling(): boolean {
  return settling;
}

export function subscribeGridZoomSettling(listener: Listener): () => void {
  listeners.add(listener);
  listener(settling);
  return () => listeners.delete(listener);
}

export function waitForGridZoomSettle(timeoutMs = 4000): Promise<void> {
  if (!settling) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(hardTimeout);
      unsub();
      resolve();
    };
    const unsub = subscribeGridZoomSettling((active) => {
      if (!active) finish();
    });
    const hardTimeout = setTimeout(finish, timeoutMs);
  });
}
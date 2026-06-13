/**
 * 启动相关可变状态（单例运行时），避免在模块顶层散落多个 let。
 * 重新初始化库时可调用 resetStartupRuntime()。
 */

export const STARTUP_BACKFILL_PROGRESS_DEBOUNCE_MS = 1500;

export type StartupRuntime = {
  libraryRootPromise: Promise<string | null> | null;
  cachedLibraryRoot: string | null;
  backgroundTasksStarted: boolean;
  microBackfillGateEntered: boolean;
  microBackfillInvokeStarted: boolean;
  microBackfillInvokeDone: boolean;
  startupBackfillRefreshScheduled: boolean;
  startupBackfillRefreshDone: boolean;
  startupBackfillProgressTimer: number | null;
  startupBackfillProgressInFlight: boolean;
  startupBackfillProgressLastAt: number;
};

function createInitialRuntime(): StartupRuntime {
  return {
    libraryRootPromise: null,
    cachedLibraryRoot: null,
    backgroundTasksStarted: false,
    microBackfillGateEntered: false,
    microBackfillInvokeStarted: false,
    microBackfillInvokeDone: false,
    startupBackfillRefreshScheduled: false,
    startupBackfillRefreshDone: false,
    startupBackfillProgressTimer: null,
    startupBackfillProgressInFlight: false,
    startupBackfillProgressLastAt: 0,
  };
}

let runtime: StartupRuntime = createInitialRuntime();

export function getStartupRuntime(): StartupRuntime {
  return runtime;
}

export function resetStartupRuntime(): void {
  if (typeof window !== 'undefined' && runtime.startupBackfillProgressTimer !== null) {
    window.clearTimeout(runtime.startupBackfillProgressTimer);
  }
  runtime = createInitialRuntime();
}
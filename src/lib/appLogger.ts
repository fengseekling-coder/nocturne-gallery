/**
 * Lightweight app logging: debug/info only in dev; warn/error always.
 * Replace ad-hoc console.* in startup and background tasks over time.
 */

const isDev = import.meta.env.DEV;

export const appLogger = {
  debug: (...args: unknown[]) => {
    if (isDev) console.log(...args);
  },
  info: (...args: unknown[]) => {
    if (isDev) console.log(...args);
  },
  warn: (...args: unknown[]) => {
    console.warn(...args);
  },
  error: (...args: unknown[]) => {
    console.error(...args);
  },
};
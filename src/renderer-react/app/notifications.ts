import type { LogEntry } from '../types';

// Pure pieces of the toast and activity feed, kept out of React so their
// behaviour can be tested without a DOM.

export type ToastType = 'success' | 'info' | 'warning' | 'error';

export interface Toast {
  id: string;
  msg: string;
  type: ToastType;
}

export const TOAST_TTL_MS = 4000;
// Cap the in-memory feed so long sessions cannot grow it without bound.
export const LOG_FEED_LIMIT = 500;

export function makeEntryId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export function appendToast(toasts: Toast[], toast: Toast): Toast[] {
  return [...toasts, toast];
}

export function removeToast(toasts: Toast[], id: string): Toast[] {
  return toasts.filter((toast) => toast.id !== id);
}

export function prependLog(logs: LogEntry[], entry: LogEntry): LogEntry[] {
  return [entry, ...logs].slice(0, LOG_FEED_LIMIT);
}

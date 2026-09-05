import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { formatLogTime } from '../api/desktop';
import { toProductUserMessage } from '../api/product-adapter';
import type { LogEntry, ProductKind } from '../types';
import {
  appendToast,
  makeEntryId,
  prependLog,
  removeToast,
  TOAST_TTL_MS,
  type Toast,
  type ToastType,
} from './notifications';

type Source = ProductKind | 'auto';

interface UseNotificationsOptions {
  // 'auto' resolves to the product currently shown; a ref keeps the callbacks
  // stable while the sidebar product changes.
  productRef: MutableRefObject<ProductKind>;
  initialLogs: LogEntry[];
}

export function useNotifications({ productRef, initialLogs }: UseNotificationsOptions) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>(initialLogs);
  const [showNotifications, setShowNotifications] = useState(false);
  const [lastReadLogId, setLastReadLogId] = useState<string | null>(null);
  const toastTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissToast = useCallback((id: string) => {
    const timer = toastTimers.current.get(id);
    if (timer) clearTimeout(timer);
    toastTimers.current.delete(id);
    setToasts((prev) => removeToast(prev, id));
  }, []);

  const addToast = useCallback((msg: string, type: ToastType = 'info', source: Source = 'auto') => {
    const id = makeEntryId('toast');
    const kind = source === 'auto' ? productRef.current : source;
    setToasts((prev) => appendToast(prev, { id, msg: toProductUserMessage(kind, msg), type }));
    const timer = setTimeout(() => {
      toastTimers.current.delete(id);
      setToasts((prev) => removeToast(prev, id));
    }, TOAST_TTL_MS);
    toastTimers.current.set(id, timer);
  }, [productRef]);

  const addLogEntry = useCallback((message: string, type: LogEntry['type'], source: Source = 'auto') => {
    const kind = source === 'auto' ? productRef.current : source;
    const entry: LogEntry = {
      id: makeEntryId('l'),
      timestamp: formatLogTime(),
      message: toProductUserMessage(kind, message),
      type,
    };
    setLogs((prev) => prependLog(prev, entry));
  }, [productRef]);

  // Opening the feed marks everything visible as read.
  useEffect(() => {
    if (!showNotifications) return;
    const newestId = logs[0]?.id;
    if (!newestId) return;
    setLastReadLogId(newestId);
  }, [showNotifications, logs]);

  // A toast timer firing after unmount would set state on a dead component.
  useEffect(() => () => {
    for (const timer of toastTimers.current.values()) clearTimeout(timer);
    toastTimers.current.clear();
  }, []);

  return {
    toasts,
    addToast,
    dismissToast,
    logs,
    addLogEntry,
    showNotifications,
    setShowNotifications,
    lastReadLogId,
  };
}

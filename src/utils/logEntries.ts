export type LogLevel = 'Trace' | 'Debug' | 'Info' | 'Warn' | 'Error';

export interface LogEntry {
  level: LogLevel;
  message: string;
}

export const MAX_LOG_LINES = 2000;

const LEVEL_NAMES: LogLevel[] = ['Trace', 'Debug', 'Info', 'Warn', 'Error'];
const LIVE_LEVELS: Record<number, LogLevel> = {
  1: 'Trace',
  2: 'Debug',
  3: 'Info',
  4: 'Warn',
  5: 'Error'
};

const levelFromMessage = (message: string): LogLevel | undefined =>
  LEVEL_NAMES.find(level => message.includes(`[${level.toUpperCase()}]`));

export const persistedLogEntry = (message: string, homePath = ''): LogEntry => ({
  level: levelFromMessage(message) || 'Debug',
  message: redactLogText(message, homePath)
});

export const redactLogText = (message: string, homePath = ''): string => {
  const normalizedHome = homePath.trim();
  const normalizedHomeWithForwardSlashes = normalizedHome.replace(/\\/g, '/');
  let redacted = message;

  if (normalizedHome) {
    redacted = redacted.split(normalizedHome).join('<HOME>');
  }
  if (normalizedHomeWithForwardSlashes && normalizedHomeWithForwardSlashes !== normalizedHome) {
    redacted = redacted.split(normalizedHomeWithForwardSlashes).join('<HOME>');
  }

  redacted = redacted.replace(
    /([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s?"'<>},\]]+)\?[^\s"'<>},\]]+/g,
    '$1?[redacted]'
  );
  redacted = redacted.replace(
    /([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s?#]+)#\S+/g,
    '$1#[redacted]'
  );
  redacted = redacted.replace(
    /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^@\s/?#]+@/g,
    '$1[redacted]@'
  );
  redacted = redacted.replace(
    /(["'])(authorization|proxy-authorization|cookie|set-cookie|password|token|secret|credential|pairing[-_ ]?token|api[-_ ]?key)(["'])(\s*[:=]\s*)["'][^"\r\n,;]*["']/gi,
    '$1$2$3$4[redacted]'
  );
  return redacted.replace(
    /(authorization|proxy-authorization|cookie|set-cookie|password|token|secret|credential|pairing[-_ ]?token|api[-_ ]?key)(\s*)([:=])(\s*)([^\r\n,;]+)/gi,
    '$1$2$3$4[redacted]'
  );
};

const mergeKey = (entry: LogEntry): string => {
  const message = entry.message
    .replace(/^\[\d{4}-\d{2}-\d{2}\]\[\d{2}:\d{2}:\d{2}\]\[[A-Z]+\](?:\[[^\]]+\])?\s*/, '')
    .replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\s*\[[A-Z]+\]\s*/, '');
  return `${entry.level}:${message}`;
};

export const liveLogEntry = (
  numericLevel: number,
  message: string,
  now: Date = new Date(),
  homePath = ''
): LogEntry => {
  const redactedMessage = redactLogText(message, homePath);
  const level = levelFromMessage(redactedMessage) || LIVE_LEVELS[numericLevel] || 'Debug';
  const alreadyFormatted = /^\[\d{4}-\d{2}-\d{2}\]\[\d{2}:\d{2}:\d{2}\]\[(TRACE|DEBUG|INFO|WARN|ERROR)\]/.test(redactedMessage);

  return {
    level,
    message: alreadyFormatted
      ? redactedMessage
      : `[${now.toISOString().replace('T', ' ').substring(0, 19)}] [${level.toUpperCase()}] ${redactedMessage}`
  };
};

export const appendBoundedLogEntries = (
  current: LogEntry[],
  additions: LogEntry[],
  limit = MAX_LOG_LINES
): LogEntry[] => {
  if (additions.length === 0) return current;
  const combined = [...current, ...additions];
  return combined.length > limit ? combined.slice(combined.length - limit) : combined;
};

export const pushBoundedLogEntry = (
  queue: LogEntry[],
  entry: LogEntry,
  limit = MAX_LOG_LINES
): void => {
  queue.push(entry);
  if (queue.length > limit) {
    queue.splice(0, queue.length - limit);
  }
};

// The live target writes after the file target, so entries received while the
// initial disk snapshot is loading can also appear at the snapshot's tail.
// Remove only the exact ordered overlap; global message de-duplication would
// incorrectly hide legitimate repeated log lines.
export const mergeLogSnapshotAndLiveEntries = (
  snapshot: LogEntry[],
  liveEntries: LogEntry[],
  limit = MAX_LOG_LINES
): LogEntry[] => {
  const maxOverlap = Math.min(snapshot.length, liveEntries.length);
  let overlap = 0;

  for (let candidate = maxOverlap; candidate > 0; candidate -= 1) {
    const snapshotStart = snapshot.length - candidate;
    let matches = true;
    for (let index = 0; index < candidate; index += 1) {
      if (mergeKey(snapshot[snapshotStart + index]) !== mergeKey(liveEntries[index])) {
        matches = false;
        break;
      }
    }
    if (matches) {
      overlap = candidate;
      break;
    }
  }

  return appendBoundedLogEntries(snapshot, liveEntries.slice(overlap), limit);
};

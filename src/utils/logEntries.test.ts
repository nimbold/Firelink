import { describe, expect, it } from 'vitest';
import {
  appendBoundedLogEntries,
  liveLogEntry,
  mergeLogSnapshotAndLiveEntries,
  persistedLogEntry,
  pushBoundedLogEntry,
  redactLogText,
  type LogEntry
} from './logEntries';

const entry = (message: string): LogEntry => ({ level: 'Info', message });

describe('log entry streaming', () => {
  it('derives levels from persisted formatted lines', () => {
    expect(persistedLogEntry('[2026-07-10][18:00:00][ERROR][firelink] failed')).toEqual({
      level: 'Error',
      message: '[2026-07-10][18:00:00][ERROR][firelink] failed'
    });
  });

  it('does not double-format backend Webview log lines', () => {
    const message = '[2026-07-10][18:00:00][WARN][firelink] retrying';
    expect(liveLogEntry(4, message).message).toBe(message);
  });

  it('formats an unformatted plugin event with its numeric level', () => {
    expect(liveLogEntry(3, 'download started', new Date('2026-07-10T14:30:00Z'))).toEqual({
      level: 'Info',
      message: '[2026-07-10 14:30:00] [INFO] download started'
    });
  });

  it('redacts live secrets, signed URL components, and the home path', () => {
    const message = 'Cookie: session=secret; https://example.com/file?token=signed https://example.com/file#fragment /Users/nima/Downloads/file';
    const redacted = redactLogText(message, '/Users/nima');

    expect(redacted).toBe('Cookie: [redacted]; https://example.com/file?[redacted] https://example.com/file#[redacted] <HOME>/Downloads/file');
    expect(redacted).not.toContain('secret');
    expect(redacted).not.toContain('signed');
    expect(redacted).not.toContain('/Users/nima');
  });

  it('redacts live content before it is formatted for display', () => {
    expect(liveLogEntry(3, 'Authorization: Bearer secret').message).toContain('Authorization: [redacted]');
    expect(liveLogEntry(3, 'Authorization: Bearer secret').message).not.toContain('secret');
  });

  it('redacts custom session and signature headers from live output', () => {
    const redacted = redactLogText('X-Request-Signature: signature-secret X-Session: session-secret');

    expect(redacted).not.toContain('signature-secret');
    expect(redacted).not.toContain('session-secret');
  });

  it('redacts legacy cookie headers and compound custom values', () => {
    const redacted = redactLogText('Set-Cookie2: legacy-cookie X-Session: id=session-secret; key=compound-secret');

    expect(redacted).not.toContain('legacy-cookie');
    expect(redacted).not.toContain('session-secret');
    expect(redacted).not.toContain('compound-secret');

    const equalsRedacted = redactLogText('Cookie2=a=1; user_id=secret; state=xyz');
    expect(equalsRedacted).not.toContain('user_id=secret');
    expect(equalsRedacted).not.toContain('state=xyz');
  });

  it('redacts persisted content and quoted credential fields', () => {
    const persisted = persistedLogEntry('{"api_key":"json-secret","path":"/Users/nima/file"}', '/Users/nima');

    expect(persisted.message).toContain('api_key');
    expect(persisted.message).not.toContain('json-secret');
    expect(persisted.message).not.toContain('/Users/nima');
  });

  it('merges only the ordered snapshot-to-stream overlap', () => {
    expect(mergeLogSnapshotAndLiveEntries(
      [entry('one'), entry('repeat'), entry('three')],
      [entry('three'), entry('repeat'), entry('four')]
    ).map(item => item.message)).toEqual(['one', 'repeat', 'three', 'repeat', 'four']);
  });

  it('deduplicates a persisted line and its differently formatted live event', () => {
    const snapshot = [persistedLogEntry('[2026-07-10][18:00:00][INFO][firelink] repeat')];
    const live = [liveLogEntry(3, 'repeat', new Date('2026-07-10T14:30:00Z'))];

    expect(mergeLogSnapshotAndLiveEntries(snapshot, live)).toEqual(snapshot);
  });

  it('preserves compact JSON delimiters while redacting URL queries', () => {
    const redacted = redactLogText('{"url":"https://example.com/file?token=secret","next":1}');

    expect(redacted).toBe('{"url":"https://example.com/file?[redacted]","next":1}');
  });

  it('bounds burst updates to the newest entries', () => {
    expect(appendBoundedLogEntries(
      [entry('old')],
      Array.from({ length: 5 }, (_, index) => entry(`new-${index}`)),
      3
    ).map(item => item.message)).toEqual(['new-2', 'new-3', 'new-4']);
  });

  it('bounds the mutable pre-render queue without copying on every event', () => {
    const queue = [entry('old')];
    for (let index = 0; index < 5; index += 1) {
      pushBoundedLogEntry(queue, entry(`new-${index}`), 3);
    }
    expect(queue.map(item => item.message)).toEqual(['new-2', 'new-3', 'new-4']);
  });
});

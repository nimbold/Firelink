import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => {
  const slots: any[] = [];
  let cursor = 0;
  let pendingEffects: any[] = [];
  let didScheduleUpdate = false;

  const sameDeps = (left: unknown[] | undefined, right: unknown[] | undefined) =>
    left !== undefined
    && right !== undefined
    && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]));

  const takeSlot = (kind: string, initialize: () => any) => {
    const index = cursor++;
    if (!slots[index]) slots[index] = { kind, ...initialize() };
    if (slots[index].kind !== kind) throw new Error(`Hook order changed at slot ${index}`);
    return slots[index];
  };

  return {
    slots,
    beginRender() {
      cursor = 0;
      pendingEffects = [];
      didScheduleUpdate = false;
    },
    finishRender() {
      for (const slot of pendingEffects) {
        slot.cleanup?.();
        slot.cleanup = slot.nextEffect?.() || undefined;
        slot.deps = slot.nextDeps;
      }
      return didScheduleUpdate;
    },
    resetHooks() {
      slots.length = 0;
      cursor = 0;
      pendingEffects = [];
      didScheduleUpdate = false;
    },
    useState(initial: unknown) {
      const slot = takeSlot('state', () => ({ value: typeof initial === 'function' ? (initial as Function)() : initial }));
      if (!slot.setState) {
        slot.setState = (next: unknown) => {
          const value = typeof next === 'function' ? (next as Function)(slot.value) : next;
          if (!Object.is(slot.value, value)) {
            slot.value = value;
            didScheduleUpdate = true;
          }
        };
      }
      return [slot.value, slot.setState];
    },
    useRef(initial: unknown) {
      const slot = takeSlot('ref', () => ({ ref: { current: initial } }));
      return slot.ref;
    },
    useCallback(callback: Function, deps?: unknown[]) {
      const slot = takeSlot('callback', () => ({ callback, deps }));
      if (!sameDeps(slot.deps, deps)) {
        slot.callback = callback;
        slot.deps = deps;
      }
      return slot.callback;
    },
    useEffect(effect: Function, deps?: unknown[]) {
      const slot = takeSlot('effect', () => ({ deps: undefined, cleanup: undefined }));
      if (!sameDeps(slot.deps, deps)) {
        slot.nextEffect = effect;
        slot.nextDeps = deps;
        pendingEffects.push(slot);
      }
    },
    invoke: vi.fn(),
    fetchMediaMetadata: vi.fn(),
    fetchMediaPlaylistMetadata: vi.fn(),
    addDownload: vi.fn(),
    addToast: vi.fn(),
    storeState: null as any,
    settingsState: null as any,
    defaultTranslator: null as any,
  };
});

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: testState.useState,
    useRef: testState.useRef,
    useCallback: testState.useCallback,
    useEffect: testState.useEffect,
  };
});

vi.mock('../store/useDownloadStore', () => {
  const useDownloadStore = Object.assign(
    vi.fn(() => testState.storeState),
    { getState: vi.fn(() => testState.storeState) }
  );
  return {
    useDownloadStore,
    getSiteLogin: vi.fn(() => null),
    getProxyArgs: vi.fn(async () => null),
  };
});

vi.mock('../store/useSettingsStore', () => ({
  useSettingsStore: Object.assign(
    vi.fn(() => testState.settingsState),
    { getState: vi.fn(() => testState.settingsState) }
  ),
}));

vi.mock('../ipc', () => ({ invokeCommand: testState.invoke }));
vi.mock('../utils/mediaMetadata', () => ({
  fetchMediaMetadataDeduped: testState.fetchMediaMetadata,
  fetchMediaPlaylistMetadataDeduped: testState.fetchMediaPlaylistMetadata,
}));
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ addToast: testState.addToast }) }));
vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({ t: testState.defaultTranslator, i18n: { language: 'en' } }),
  };
});
vi.mock('../hooks/useModalFocus', () => ({ useModalFocus: () => null, isTopmostModal: () => true }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn(async () => undefined) }));
vi.mock('./DuplicateResolutionModal', () => ({ DuplicateResolutionModal: () => null }));
vi.mock('./TorrentWebSeedEditor', () => ({ TorrentWebSeedEditor: () => null }));
vi.mock('./AddDownloadPreviewRow', () => ({ AddDownloadPreviewRow: () => null }));
vi.mock('lucide-react', () => {
  const Icon = () => null;
  return {
    FolderPlus: Icon, Save: Icon, Settings: Icon, Shield: Icon, RefreshCw: Icon, FileText: Icon,
    HardDrive: Icon, Database: Icon, Link: Icon, ArrowRight: Icon, Play: Icon, ChevronDown: Icon,
    ChevronRight: Icon, Video: Icon, Film: Icon, Music: Icon, Copy: Icon,
  };
});
vi.mock('../utils/platform', () => ({ getPlatformInfo: vi.fn(async () => ({ os: 'linux' })) }));
vi.mock('../utils/downloadLocations', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils/downloadLocations')>();
  return {
    ...actual,
    expandTilde: vi.fn(async (path: string) => path.replace(/^~/, '/Users/test')),
    resolveCategoryDestination: vi.fn(async () => '/downloads'),
    resolveDownloadFilePath: vi.fn(async (_destination: string, fileName: string) => `/downloads/${fileName}`),
    resolveInitialAddWindowLocation: vi.fn(() => ({ path: '/downloads', isManual: false })),
  };
});

import { AddDownloadsModal } from './AddDownloadsModal';

const defaultInvoke = async (command: string) => {
  switch (command) {
    case 'get_free_space': return '1000000';
    case 'fetch_metadata': return { filename: 'sample.bin', size: '12 B', size_bytes: 12, resumable: true };
    case 'inspect_download_target': return { kind: 'missing', fingerprint: null, ownedBy: null };
    case 'inspect_torrent': return {
      torrentPath: '/cache/draft.torrent',
      infoHash: '0123456789abcdef',
      name: 'sample-torrent',
      files: [{ index: 0, path: 'sample.bin', length: 12 }],
      totalBytes: 12,
    };
    case 'rekey_torrent_metadata': return '/cache/accepted.torrent';
    default: return undefined;
  }
};

const makeTranslator = () => {
  const keys = new Proxy({}, {
    get(_target, property) {
      return new Proxy({}, {
        get(_nestedTarget, nestedProperty) {
          return `${String(property)}.${String(nestedProperty)}`;
        },
      });
    },
  });
  return (selector: (value: any) => unknown) => String(selector(keys));
};

let tree: any;

const renderUntilStable = () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    testState.beginRender();
    tree = AddDownloadsModal();
    if (!testState.finishRender()) return tree;
  }
  throw new Error('AddDownloadsModal did not settle after synchronous effects');
};

const waitForPostcondition = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    renderUntilStable();
    if (condition()) return;
    // Yield the event loop so async metadata work and its final state update
    // can settle before checking the actual rendered postcondition again.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('AddDownloadsModal did not reach the expected review state');
};

const elements = (root: any): any[] => {
  const found: any[] = [];
  const visit = (value: any) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object' || !value.props) return;
    found.push(value);
    visit(value.props.children);
  };
  visit(root);
  return found;
};

const textOf = (value: any): string => {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(' ');
  return value?.props ? textOf(value.props.children) : '';
};

const linkInput = () => elements(tree).find(element => element.type === 'textarea' && element.props.id === 'add-download-links-input');
const startButton = () => elements(tree).find(element =>
  element.type === 'button' && String(element.props.className).includes('add-download-button-primary')
);
const previewRows = () => elements(tree).filter(element =>
  typeof element.props.file === 'string' && typeof element.props.onSelectDetails === 'function'
);
const draftRows = () => testState.slots
  .filter(slot => slot?.kind === 'state' && Array.isArray(slot.value))
  .flatMap(slot => slot.value)
  .filter((value: any) => value && typeof value.sourceUrl === 'string' && typeof value.status === 'string');
const chooseButton = (key: string) => elements(tree).find(element =>
  element.type === 'button' && textOf(element).includes(key)
);

const enterLink = async (url: string) => {
  const input = linkInput();
  expect(input).toBeDefined();
  input.props.onChange({ target: { value: url } });
  renderUntilStable();
  await waitForPostcondition(() => {
    const row = previewRows()[0];
    return Boolean(row && !textOf(row.props.details).includes('addDownloads.fetching'));
  });
};

const startReviewedDownload = async () => {
  const button = startButton();
  expect(button).toBeDefined();
  expect(button.props.disabled).toBe(false);
  await button.props.onClick();
  renderUntilStable();
};

describe('AddDownloadsModal link review and dispatch', () => {
  beforeEach(() => {
    testState.resetHooks();
    testState.invoke.mockReset();
    testState.fetchMediaMetadata.mockReset();
    testState.fetchMediaPlaylistMetadata.mockReset();
    testState.addDownload.mockReset().mockResolvedValue(true);
    testState.addToast.mockReset();
    testState.invoke.mockImplementation(defaultInvoke as any);
    testState.fetchMediaMetadata.mockImplementation(async () => ({
      title: 'Example video',
      formats: [{ format_id: 'best', ext: 'mp4', resolution: '720p' }],
    } as any));
    testState.fetchMediaPlaylistMetadata.mockResolvedValue({ entries: [] } as any);
    testState.defaultTranslator = makeTranslator();
    testState.settingsState = {
      baseDownloadFolder: '/downloads',
      rememberLastUsedDownloadDirectory: false,
      lastUsedDownloadDirectory: null,
      perServerConnections: 16,
      mediaCookieSource: 'none',
      mediaCookieFile: null,
      mediaCookieBrowserProfiles: {},
      customUserAgent: '',
      keychainAccessReady: false,
      keychainPromptDismissed: false,
      askWhereToSaveEachFile: false,
      setShowKeychainModal: vi.fn(),
    };
    testState.storeState = {
      isAddModalOpen: true,
      pendingAddUrls: '',
      pendingAddReferer: '',
      pendingAddFilename: '',
      pendingAddHeaders: '',
      pendingAddCookies: '',
      pendingAddMediaUrls: [],
      pendingAddTorrentUrls: [],
      pendingAddBatchName: '',
      pendingAddRequestContexts: {},
      pendingAddRequestVersion: 0,
      toggleAddModal: vi.fn(),
      setPendingAddModalBusy: vi.fn(),
      releasePendingAddHandoffs: vi.fn(() => ({ handoffs: [], mediaDiscoveryUpdates: [] })),
      addDownload: testState.addDownload,
      queues: [{ id: 'main', name: 'Main Queue', isMain: true }],
      downloads: [],
    };
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      confirm: vi.fn(() => true),
    });
    renderUntilStable();
  });

  it('reviews a normal URL and dispatches it through the normal download route', async () => {
    const url = 'https://example.com/sample.bin';
    await enterLink(url);

    expect(previewRows()).toHaveLength(1);
    expect(previewRows()[0].props.file).toBe('sample.bin');
    expect(textOf(previewRows()[0].props.details)).toContain('addDownloads.ready');
    await startReviewedDownload();

    expect(testState.addDownload).toHaveBeenCalledTimes(1);
    const [download, action] = testState.addDownload.mock.calls[0];
    expect(download.url).toBe(url);
    expect(download.isMedia).toBe(false);
    expect(download.isTorrent).toBe(false);
    expect(action).toEqual({ type: 'start-now' });
  });

  it('keeps a magnet Torrent startable when optional metadata inspection fails', async () => {
    const url = 'magnet:?xt=urn:btih:0123456789abcdef&dn=sample.bin';
    testState.invoke.mockImplementation(async (command: string, args?: any) => {
      if (command === 'inspect_torrent' && args?.source === url) throw new Error('Magnet metadata unavailable');
      return defaultInvoke(command);
    });
    await enterLink(url);

    expect(previewRows()).toHaveLength(1);
    expect(textOf(previewRows()[0].props.details)).toContain('addDownloads.metadataFailed');
    previewRows()[0].props.onSelectDetails();
    renderUntilStable();
    expect(startButton().props.disabled).toBe(false);
    await startReviewedDownload();

    expect(testState.addDownload).toHaveBeenCalledTimes(1);
    const [download, action] = testState.addDownload.mock.calls[0];
    expect(download.url).toBe(url);
    expect(download.isTorrent).toBe(true);
    expect(download.isMedia).toBe(false);
    expect(action).toEqual({ type: 'start-now' });
  });

  it('reviews a remote .torrent URL and dispatches its accepted Torrent metadata', async () => {
    const url = 'https://example.com/sample.torrent';
    await enterLink(url);

    expect(previewRows()).toHaveLength(1);
    expect(textOf(previewRows()[0].props.details)).toContain('addDownloads.ready');
    expect(testState.invoke).toHaveBeenCalledWith('inspect_torrent', expect.objectContaining({ source: url, torrent: true }));
    await startReviewedDownload();

    expect(testState.addDownload).toHaveBeenCalledTimes(1);
    const [download, action] = testState.addDownload.mock.calls[0];
    expect(download.url).toBe('torrent:0123456789abcdef');
    expect(download.isTorrent).toBe(true);
    expect(download.torrentPath).toBe('/cache/accepted.torrent');
    expect(download.isMedia).toBe(false);
    expect(action).toEqual({ type: 'start-now' });
  });

  it('keeps a media link blocked after metadata failure until default-format fallback, then dispatches it as media', async () => {
    const url = 'https://www.youtube.com/watch?v=video123';
    testState.fetchMediaMetadata.mockRejectedValue(new Error('No media formats available'));
    await enterLink(url);

    expect(previewRows()).toHaveLength(1);
    expect(startButton().props.disabled).toBe(true);
    previewRows()[0].props.onSelectDetails();
    renderUntilStable();
    const fallbackButton = chooseButton('addDownloads.useDefaultMediaFormat');
    expect(fallbackButton).toBeDefined();
    fallbackButton.props.onClick();
    renderUntilStable();
    expect(startButton().props.disabled).toBe(false);

    await startReviewedDownload();

    expect(testState.addDownload).toHaveBeenCalledTimes(1);
    const [download, action] = testState.addDownload.mock.calls[0];
    expect(download.url).toBe(url);
    expect(download.isMedia).toBe(true);
    expect(download.isTorrent).toBe(false);
    expect(download.mediaFormatSelector).toBeUndefined();
    expect(action).toEqual({ type: 'start-now' });
  });

  it('keeps Treat as File through a later media discovery URL replacement', async () => {
    const pageUrl = 'https://video.example/watch?id=1';
    const manifestUrl = 'https://cdn.example/master.m3u8';
    const initialContext = {
      version: 1,
      handoffId: 'media-handoff-1',
      referer: pageUrl,
      filename: '',
      headers: '',
      cookies: '',
      media: true,
      mediaMode: 'media'
    };
    Object.assign(testState.storeState, {
      pendingAddUrls: pageUrl,
      pendingAddMediaUrls: [pageUrl],
      pendingAddRequestContexts: { [pageUrl]: initialContext },
      pendingAddRequestVersion: 1
    });
    renderUntilStable();
    await waitForPostcondition(() => {
      const preview = previewRows()[0];
      return Boolean(preview && !textOf(preview.props.details).includes('addDownloads.fetching'));
    });

    previewRows()[0].props.onSelectDetails();
    renderUntilStable();
    const treatAsFile = chooseButton('addDownloads.treatAsFile');
    expect(treatAsFile).toBeDefined();
    treatAsFile.props.onClick();
    renderUntilStable();
    await waitForPostcondition(() => {
      const preview = previewRows()[0];
      return Boolean(preview && !textOf(preview.props.details).includes('addDownloads.fetching'));
    });
    const mediaMetadataCallCountBeforeDiscovery = testState.fetchMediaMetadata.mock.calls.length;

    Object.assign(testState.storeState, {
      pendingAddUrls: manifestUrl,
      pendingAddMediaUrls: [manifestUrl],
      pendingAddRequestContexts: {
        [manifestUrl]: {
          ...initialContext,
          version: 2,
          replacesUrl: pageUrl,
          referer: pageUrl
        }
      },
      pendingAddRequestVersion: 2
    });
    renderUntilStable();
    await waitForPostcondition(() => {
      const row = draftRows().find((candidate: any) => candidate.sourceUrl === manifestUrl);
      return Boolean(row && row.status !== 'loading' && row.mediaMode === 'file' && row.isMedia === false);
    });
    renderUntilStable();
    expect(previewRows()[0].props.file).toBe('sample.bin');

    expect(testState.fetchMediaMetadata).toHaveBeenCalledTimes(mediaMetadataCallCountBeforeDiscovery);
    await startReviewedDownload();

    expect(testState.addDownload).toHaveBeenCalledTimes(1);
    const [download, action] = testState.addDownload.mock.calls[0];
    expect(download.url).toBe(manifestUrl);
    expect(download.isMedia).toBe(false);
    expect(download.isTorrent).toBe(false);
    expect(action).toEqual({ type: 'start-now' });
  });
});

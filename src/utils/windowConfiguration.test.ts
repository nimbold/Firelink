import { describe, expect, it } from 'vitest';
import baseConfiguration from '../../src-tauri/tauri.conf.json';
import macosConfiguration from '../../src-tauri/tauri.macos.conf.json';
import windowsConfiguration from '../../src-tauri/tauri.windows.conf.json';
import linuxConfiguration from '../../src-tauri/tauri.linux.conf.json';

const configurations = [
  ['base', baseConfiguration],
  ['macOS', macosConfiguration],
  ['Windows', windowsConfiguration],
  ['Linux', linuxConfiguration]
] as const;

describe('main window configuration', () => {
  it('uses the content-appropriate first-run size on every platform', () => {
    for (const [platform, config] of configurations) {
      const mainWindow = config.app.windows[0];
      expect(mainWindow, platform).toMatchObject({
        width: 1280,
        height: 800,
        minWidth: 960,
        minHeight: 640
      });
    }
  });

  it('uses native elevation on macOS where undecorated window shadows conform to the surface', () => {
    expect(macosConfiguration.app.windows[0], 'macOS').toMatchObject({
      transparent: true,
      decorations: false,
      shadow: true,
    });
  });

  it('keeps Windows transparent without native shadow bleed outside rounded corners', () => {
    expect(windowsConfiguration.app.windows[0], 'Windows').toMatchObject({
      transparent: true,
      decorations: false,
      shadow: false,
    });
  });

  it('keeps Linux on the renderer contour without claiming native shadow support', () => {
    const mainWindow = linuxConfiguration.app.windows[0];
    expect(mainWindow, 'Linux').toMatchObject({
      transparent: false,
      decorations: false,
      shadow: false,
    });
  });
});

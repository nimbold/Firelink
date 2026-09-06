import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const windowStyles = fs.readFileSync('src/index.css', 'utf8');
const propertiesWindowSource = fs.readFileSync('src-tauri/src/properties_window.rs', 'utf8');
const mainWindowSource = fs.readFileSync('src-tauri/src/lib.rs', 'utf8');
const windowsConfiguration = JSON.parse(
  fs.readFileSync('src-tauri/tauri.windows.conf.json', 'utf8')
);

const cssBlock = selector => {
  const opening = `${selector} {`;
  const start = windowStyles.indexOf(opening);
  assert.notEqual(start, -1, `${selector} should exist`);
  const end = windowStyles.indexOf('}', start + opening.length);
  assert.notEqual(end, -1, `${selector} should have a closing brace`);
  return windowStyles.slice(start, end + 1);
};

test('Windows native shadows remain disabled for the main and Properties windows', () => {
  assert.deepEqual(
    {
      transparent: windowsConfiguration.app.windows[0].transparent,
      decorations: windowsConfiguration.app.windows[0].decorations,
      shadow: windowsConfiguration.app.windows[0].shadow,
    },
    { transparent: true, decorations: false, shadow: false }
  );
  assert.match(
    mainWindowSource,
    /let main_window_config = app\s*\.config\(\)\s*\.app\s*\.windows[\s\S]*?\.find\(\|window\| window\.label == "main"\)/
  );
  assert.match(
    mainWindowSource,
    /WebviewWindowBuilder::from_config\(\s*app\.handle\(\),\s*&main_window_config,\s*\)/
  );
  assert.match(
    propertiesWindowSource,
    /#\[cfg\(target_os = "windows"\)\]\s*let builder = builder\.transparent\(true\)\.shadow\(false\);/
  );
});

test('Windows selects stronger renderer-owned contours for every theme', () => {
  const expectedTokens = [
    [':root', '220 12% 30% / 0.60', '220 10% 30% / 0.18'],
    ['.theme-light', '220 12% 30% / 0.60', '220 10% 30% / 0.18'],
    ['.theme-dark', '0 0% 100% / 0.35', '0 0% 100% / 0.14'],
    ['.theme-dracula', '228 14% 84% / 0.45', '228 14% 84% / 0.18'],
    ['.theme-nord', '218 27% 88% / 0.45', '218 27% 88% / 0.18'],
  ];

  for (const [selector, active, inactive] of expectedTokens) {
    const block = cssBlock(selector);
    assert.match(block, new RegExp(`--window-frame-windows-active: ${active.replace('.', '\\.')}\\s*;`));
    assert.match(block, new RegExp(`--window-frame-windows-inactive: ${inactive.replace('.', '\\.')}\\s*;`));
  }

  const windowsBlock = cssBlock('html[data-platform="windows"]');
  assert.match(
    windowsBlock,
    /--window-frame-active:\s*var\(--window-frame-windows-active\);/
  );
  assert.match(
    windowsBlock,
    /--window-frame-inactive:\s*var\(--window-frame-windows-inactive\);/
  );
});

test('maximized Windows shells remain square and borderless', () => {
  assert.match(
    windowStyles,
    /html\[data-platform="windows"\] :is\(\.app-shell, \.properties-window-shell\)\[data-window-maximized="true"\] \{\s*border-color:\s*transparent;/
  );
  assert.match(
    windowStyles,
    /html\[data-platform="linux"\] :is\(\.app-shell, \.properties-window-shell\),\s*html\[data-platform="windows"\] :is\(\.app-shell, \.properties-window-shell\)\[data-window-maximized="true"\] \{\s*border-radius:\s*0;/
  );
});

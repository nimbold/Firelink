import fs from 'node:fs';
import path from 'node:path';

const APP_RUN_WRAPPED_EXEC = /^[\t ]*exec[\t ]+"?\$this_dir"?\/AppRun\.wrapped(?=[\t ]|$)/m;
const APP_RUN_GTK_HOOK = /^[\t ]*source[\t ]+"\$this_dir"\/apprun-hooks\/"linuxdeploy-plugin-gtk\.sh"(?=[\t ]|$)/m;

function appDirEntry(root, name, label, type) {
  const entry = name === '.' ? root : path.join(root, name);
  let info;
  try {
    info = fs.lstatSync(entry);
  } catch (error) {
    throw new Error(`${label} is missing or cannot be inspected: ${error.message}`, { cause: error });
  }

  if (info.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link.`);
  }
  if (type === 'directory' && !info.isDirectory()) {
    throw new Error(`${label} is not a directory.`);
  }
  if (type === 'file' && !info.isFile()) {
    throw new Error(`${label} is not a regular file.`);
  }

  return entry;
}

function permissionBits(entry) {
  return fs.lstatSync(entry).mode & 0o777;
}

function assertOtherReadableExecutable(entry, label) {
  const mode = permissionBits(entry);
  if ((mode & 0o005) !== 0o005) {
    throw new Error(
      `${label} must be readable and executable by other users for root-owned AppImage mounts; found mode 0${mode.toString(8).padStart(3, '0')}.`,
    );
  }
}

function assertOtherDirectoryAccess(entry, label) {
  const mode = permissionBits(entry);
  if ((mode & 0o005) !== 0o005) {
    throw new Error(
      `${label} must be readable and traversable by other users for root-owned AppImage mounts; found mode 0${mode.toString(8).padStart(3, '0')}.`,
    );
  }
}

function assertOtherReadable(entry, label) {
  const mode = permissionBits(entry);
  if ((mode & 0o004) !== 0o004) {
    throw new Error(
      `${label} must be readable by other users for root-owned AppImage mounts; found mode 0${mode.toString(8).padStart(3, '0')}.`,
    );
  }
}

function chmod(entry, mode, label) {
  try {
    fs.chmodSync(entry, mode);
  } catch (error) {
    throw new Error(`${label} permissions could not be normalized: ${error.message}`, { cause: error });
  }
}

function checkAppRunPermissions(root, label, normalize) {
  const appDir = appDirEntry(root, '.', `${label} AppDir root`, 'directory');
  const appRun = appDirEntry(root, 'AppRun', `${label} AppRun`, 'file');
  const appRunWrapped = appDirEntry(root, 'AppRun.wrapped', `${label} AppRun.wrapped launcher`, 'file');
  const hookDirectory = appDirEntry(root, 'apprun-hooks', `${label} AppRun hook directory`, 'directory');
  const gtkHook = appDirEntry(
    root,
    path.join('apprun-hooks', 'linuxdeploy-plugin-gtk.sh'),
    `${label} GTK AppRun hook`,
    'file',
  );

  const appRunContents = fs.readFileSync(appRun, 'utf8');
  if (!APP_RUN_WRAPPED_EXEC.test(appRunContents)) {
    throw new Error(
      `${label} AppRun does not invoke the supported AppRun.wrapped launcher; inspect the new launcher structure before packaging.`,
    );
  }
  if (!APP_RUN_GTK_HOOK.test(appRunContents)) {
    throw new Error(
      `${label} AppRun does not source the supported GTK hook; inspect the new launcher structure before packaging.`,
    );
  }

  if (normalize) {
    chmod(appDir, 0o755, `${label} AppDir root`);
    chmod(appRun, 0o755, `${label} AppRun`);
    chmod(hookDirectory, 0o755, `${label} AppRun hook directory`);
    chmod(gtkHook, 0o644, `${label} GTK AppRun hook`);
    chmod(appRunWrapped, 0o755, `${label} AppRun.wrapped launcher`);
  }

  assertOtherDirectoryAccess(appDir, `${label} AppDir root`);
  assertOtherReadableExecutable(appRun, `${label} AppRun`);
  assertOtherDirectoryAccess(hookDirectory, `${label} AppRun hook directory`);
  assertOtherReadable(gtkHook, `${label} GTK AppRun hook`);
  assertOtherReadableExecutable(appRunWrapped, `${label} AppRun.wrapped launcher`);
  return true;
}

export function normalizeAppRunPermissions(root, label = 'AppDir') {
  return checkAppRunPermissions(root, label, true);
}

export function verifyAppRunPermissions(root, label = 'AppImage') {
  return checkAppRunPermissions(root, label, false);
}

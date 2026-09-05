import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removePathWithRetry } from './engine-payload-promotion.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const ARCH_MAP = { x64: 'x86_64', arm64: 'aarch64' };
const PLATFORM_MAP = {
  darwin: 'apple-darwin',
  win32: 'pc-windows-msvc',
  linux: 'unknown-linux-gnu',
};
const SAFE_TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function argumentValue(args, name) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  const inline = args.find(argument => argument.startsWith(prefix));
  return inline?.slice(prefix.length);
}

export function assertSafeTarget(target) {
  if (typeof target !== 'string' || !SAFE_TARGET_PATTERN.test(target)) {
    throw new Error(`Invalid target triple: ${target ?? '<missing>'}`);
  }
  return target;
}

export function resolveTargetTriple(
  args = process.argv.slice(2),
  env = process.env,
  platform = os.platform(),
  arch = os.arch(),
) {
  const hostTarget = ARCH_MAP[arch] && PLATFORM_MAP[platform]
    ? `${ARCH_MAP[arch]}-${PLATFORM_MAP[platform]}`
    : undefined;
  const target = argumentValue(args, '--target')
    || env.TAURI_ENV_TARGET_TRIPLE
    || env.FIRELINK_TARGET_TRIPLE
    || hostTarget;
  return assertSafeTarget(target);
}

export function resolveOutputRoot(args = process.argv.slice(2), env = process.env) {
  const outputRoot = argumentValue(args, '--output-root') || env.FIRELINK_ENGINE_OUTPUT_ROOT;
  if (!outputRoot) {
    throw new Error(
      'No engine output workspace was provided. Run through npm run tauri or set FIRELINK_ENGINE_OUTPUT_ROOT.',
    );
  }
  return path.resolve(outputRoot);
}

function canonicalPathWithMissingComponents(value) {
  let cursor = path.resolve(value);
  const missing = [];

  while (true) {
    try {
      const canonical = fs.realpathSync.native(cursor);
      return path.join(canonical, ...missing.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function comparablePath(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithinPath(root, candidate) {
  const relative = path.relative(comparablePath(root), comparablePath(candidate));
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function assertSafeOutputRoot(outputRoot, forbiddenRoots = []) {
  const canonicalOutputRoot = canonicalPathWithMissingComponents(outputRoot);
  for (const forbiddenRoot of forbiddenRoots) {
    const canonicalForbiddenRoot = canonicalPathWithMissingComponents(forbiddenRoot);
    if (isWithinPath(canonicalForbiddenRoot, canonicalOutputRoot)) {
      throw new Error(
        `Refusing to use a repository-shared engine workspace: ${outputRoot}`,
      );
    }
  }
  return canonicalOutputRoot;
}

export function stripVerbatimPrefix(filePath) {
  return typeof filePath === 'string' && filePath.startsWith('\\\\?\\')
    ? filePath.slice(4)
    : filePath;
}

export function resolveWorkspaceTempBase(referencePath = repoRoot) {
  if (process.env.FIRELINK_ENGINE_WORKSPACE_BASE) {
    return path.resolve(process.env.FIRELINK_ENGINE_WORKSPACE_BASE);
  }

  if (process.platform === 'win32') {
    const referenceDrive = path.parse(path.resolve(referencePath)).root.toLowerCase();

    if (process.env.RUNNER_TEMP) {
      const runnerTemp = path.resolve(process.env.RUNNER_TEMP);
      if (path.parse(runnerTemp).root.toLowerCase() === referenceDrive) {
        return runnerTemp;
      }
    }

    const osTemp = path.resolve(os.tmpdir());
    if (path.parse(osTemp).root.toLowerCase() === referenceDrive) {
      return osTemp;
    }

    const adjacentTemp = path.join(path.resolve(referencePath, '..'), '.firelink-engine-workspaces');
    fs.mkdirSync(adjacentTemp, { recursive: true, mode: 0o700 });
    return adjacentTemp;
  }

  if (process.env.RUNNER_TEMP) {
    return path.resolve(process.env.RUNNER_TEMP);
  }

  return os.tmpdir();
}

export function createEngineWorkspace(target) {
  assertSafeTarget(target);
  const tempBase = resolveWorkspaceTempBase();
  const rawWorkspace = fs.realpathSync.native(
    fs.mkdtempSync(path.join(tempBase, `firelink-engine-${target}-${process.pid}-`)),
  );
  const workspace = stripVerbatimPrefix(rawWorkspace);
  const outputRoot = path.join(workspace, 'engine-dist');
  fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  return { outputRoot, runtimeRoot: outputRoot, workspace };
}

export function engineResourceConfig(outputRoot) {
  const source = `${stripVerbatimPrefix(path.resolve(outputRoot))}${path.sep}`;
  return JSON.stringify({
    bundle: {
      resources: {
        [source]: 'engine-dist/',
      },
    },
  });
}

export async function removeEngineWorkspace(workspace) {
  const resolved = stripVerbatimPrefix(path.resolve(workspace));
  const basename = path.basename(resolved);
  if (!basename.startsWith('firelink-engine-')) {
    throw new Error(`Refusing to remove an unexpected engine workspace: ${resolved}`);
  }
  await removePathWithRetry(resolved);
}

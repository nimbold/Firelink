import { defineConfig } from "vitest/config";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from '@tailwindcss/vite';

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const buildId = (() => {
  // Release-candidate builds can keep the same semantic app version. The
  // consent identity must represent the actual input to this build, not only
  // the last committed revision: local rebuilds, untracked source files, and
  // packaged working trees can have different code-signing identities while
  // sharing the same HEAD or having no Git metadata at all.
  const configured = process.env.VITE_BUILD_ID?.trim();
  if (configured) return configured;

  const projectRoot = process.cwd();
  const inputRoots = [
    'src',
    'src-tauri/src',
    'src-tauri/capabilities',
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
    'src-tauri/build.rs',
    'src-tauri/tauri.conf.json',
    'index.html',
    'package.json',
    'package-lock.json',
    'vite.config.ts'
  ];
  const files: string[] = [];
  const collectFiles = (path: string) => {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return;
    const stats = statSync(path);
    if (stats.isFile()) {
      files.push(path);
      return;
    }
    if (!stats.isDirectory()) return;
    for (const entry of readdirSync(path).sort()) {
      collectFiles(resolve(path, entry));
    }
  };

  inputRoots.forEach(input => collectFiles(resolve(projectRoot, input)));
  if (files.length === 0) return process.env.GITHUB_SHA?.trim() || 'unknown';

  const fingerprint = createHash('sha256');
  for (const file of files.sort()) {
    fingerprint.update(relative(projectRoot, file));
    fingerprint.update('\0');
    fingerprint.update(readFileSync(file));
    fingerprint.update('\0');
  }
  return fingerprint.digest('hex').slice(0, 24);
})();

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  define: {
    'import.meta.env.VITE_BUILD_ID': JSON.stringify(buildId)
  },
  test: {
    exclude: [
      "Extensions/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/.{idea,git,cache,output,temp}/**"
    ]
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));

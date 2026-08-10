/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { computeCacheVersion, stampServiceWorker } from './scripts/sw-version';

/**
 * Stamps dist/sw.js with a cache name derived from the emitted bundle, so
 * every deploy that changes any build output also bumps the SW cache version
 * and old clients drop their stale shell on activate.
 */
function stampSwCacheVersion(): Plugin {
  let outDir = 'dist';
  let version = '';
  return {
    name: 'stamp-sw-cache-version',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    generateBundle(_options, bundle) {
      const files: Record<string, string> = {};
      for (const [name, item] of Object.entries(bundle)) {
        files[name] = item.type === 'chunk' ? item.code : String(item.source);
      }
      version = computeCacheVersion(files);
    },
    closeBundle() {
      const swPath = join(resolve(outDir), 'sw.js');
      writeFileSync(swPath, stampServiceWorker(readFileSync(swPath, 'utf8'), version));
    },
  };
}

export default defineConfig({
  base: '/voice_keyboard/',
  plugins: [react(), stampSwCacheVersion()],
  test: {
    globals: true,
    environment: 'node',
  },
});

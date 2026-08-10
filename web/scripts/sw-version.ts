/**
 * Build-time stamping of the service worker cache version.
 *
 * The service worker source (public/sw.js) ships with SW_CACHE_SENTINEL in
 * place of a real cache name. At build time the Vite plugin in vite.config.ts
 * hashes the emitted bundle and stamps a content-derived version into
 * dist/sw.js, so every deploy that changes any output also changes the cache
 * name — which is what makes old clients drop their stale cache on activate.
 */

export const SW_CACHE_SENTINEL = '__SW_CACHE_VERSION__';

export const SW_CACHE_PREFIX = 'voicekb-';

/**
 * Deterministic content hash (FNV-1a 64-bit, hex). Pure TS so it runs in the
 * Vite config, in Vitest, and under tsc without @types/node.
 */
export function computeCacheVersion(files: Record<string, string>): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  const mix = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      hash ^= BigInt(text.charCodeAt(i));
      hash = (hash * prime) & mask;
    }
  };
  for (const name of Object.keys(files).sort()) {
    mix(name);
    mix('\0');
    mix(files[name]);
    mix('\0');
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Replace the sentinel in the service worker source with the stamped version.
 * Throws if the sentinel is missing, so a sw.js that regressed to a hardcoded
 * cache name fails the build instead of silently shipping unstamped.
 */
export function stampServiceWorker(source: string, version: string): string {
  if (!source.includes(SW_CACHE_SENTINEL)) {
    throw new Error(
      `sw.js is missing the ${SW_CACHE_SENTINEL} sentinel — refusing to build with a hardcoded cache name.`,
    );
  }
  return source.split(SW_CACHE_SENTINEL).join(version);
}

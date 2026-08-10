import { describe, expect, it } from 'vitest';
import swSource from '../public/sw.js?raw';
import {
  computeCacheVersion,
  stampServiceWorker,
  SW_CACHE_PREFIX,
  SW_CACHE_SENTINEL,
} from '../scripts/sw-version';

/**
 * Guards the fix for "service worker traps users on v1 forever": the cache
 * name must be stamped from build content on every deploy, never hardcoded.
 */
describe('service worker cache versioning', () => {
  it('ships sw.js with the version sentinel, not a hardcoded cache name', () => {
    expect(swSource).toContain(SW_CACHE_SENTINEL);
  });

  it('stamps the sentinel into the cache name', () => {
    const stamped = stampServiceWorker(swSource, 'abc123');
    expect(stamped).not.toContain(SW_CACHE_SENTINEL);
    expect(stamped).toContain(`'${SW_CACHE_PREFIX}abc123'`);
  });

  it('fails the build if the sentinel is missing', () => {
    expect(() => stampServiceWorker("const CACHE = 'voicekb-v1';", 'abc123')).toThrow(
      SW_CACHE_SENTINEL,
    );
  });

  it('derives the same version from identical build output', () => {
    const files = { 'index.html': '<html>a</html>', 'assets/app.js': 'code()' };
    expect(computeCacheVersion(files)).toBe(computeCacheVersion({ ...files }));
  });

  it('derives a different version when any build output changes', () => {
    const before = computeCacheVersion({ 'index.html': '<html>a</html>', 'assets/app.js': 'a' });
    const after = computeCacheVersion({ 'index.html': '<html>a</html>', 'assets/app.js': 'b' });
    expect(before).not.toBe(after);
  });
});

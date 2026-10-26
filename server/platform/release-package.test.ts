import { describe, expect, it } from 'vitest';
import { isExcludedReleaseFile } from '../../scripts/package-platform';

describe('Agent Office release file selection', () => {
  it('omits the Habblaud-only build stamp but keeps Agent Office runtime bundles', () => {
    expect(isExcludedReleaseFile('dist/build.json')).toBe(true);
    expect(isExcludedReleaseFile('dist\\build.json')).toBe(true);
    expect(isExcludedReleaseFile('dist/server/platform.js')).toBe(false);
  });
});

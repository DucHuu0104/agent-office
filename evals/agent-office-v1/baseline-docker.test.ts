import { describe, expect, it, vi } from 'vitest';
import { isDockerImageAvailableLocally } from './baseline-docker';

const digest = '35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213';
const image = `node:22.12.0-bookworm-slim@sha256:${digest}`;

describe('baseline Docker image preflight', () => {
  it('accepts an exact local digest reference when inspect supports tag@digest', async () => {
    const inspect = vi.fn(async () => ({ stdout: '[]' }));

    await expect(isDockerImageAvailableLocally(image, inspect)).resolves.toBe(true);
    expect(inspect).toHaveBeenCalledExactlyOnceWith(['image', 'inspect', image]);
  });

  it('falls back to the local tagged image and verifies the configured digest', async () => {
    const inspect = vi.fn(async (args: string[]) => {
      if (args[2] === image) throw new Error('Docker Desktop cannot resolve tag@digest locally.');
      return { stdout: JSON.stringify([`node@sha256:${digest}`]) };
    });

    await expect(isDockerImageAvailableLocally(image, inspect)).resolves.toBe(true);
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(inspect).toHaveBeenNthCalledWith(2, ['image', 'inspect', '--format', '{{json .RepoDigests}}', 'node:22.12.0-bookworm-slim']);
  });

  it('refuses an image with the wrong digest, repository, missing tag, or malformed RepoDigests', async () => {
    const wrongDigest = vi.fn(async (args: string[]) => {
      if (args[2] === image) throw new Error('not found');
      return { stdout: JSON.stringify(['node@sha256:' + 'a'.repeat(64)]) };
    });
    const wrongRepository = vi.fn(async (args: string[]) => {
      if (args[2] === image) throw new Error('not found');
      return { stdout: JSON.stringify([`other/node@sha256:${digest}`]) };
    });
    const untagged = vi.fn(async () => ({ stdout: '[]' }));
    const malformed = vi.fn(async (args: string[]) => {
      if (args[2] === image) throw new Error('not found');
      return { stdout: 'not json' };
    });

    await expect(isDockerImageAvailableLocally(image, wrongDigest)).resolves.toBe(false);
    await expect(isDockerImageAvailableLocally(image, wrongRepository)).resolves.toBe(false);
    await expect(isDockerImageAvailableLocally(`node@sha256:${digest}`, untagged)).resolves.toBe(false);
    await expect(isDockerImageAvailableLocally(image, malformed)).resolves.toBe(false);
    expect(untagged).not.toHaveBeenCalled();
  });

  it('never inspects a non-digest-pinned reference', async () => {
    const inspect = vi.fn(async () => ({ stdout: '[]' }));

    await expect(isDockerImageAvailableLocally('node:latest', inspect)).resolves.toBe(false);
    expect(inspect).not.toHaveBeenCalled();
  });
});

export interface DockerImageInspectResult {
  stdout: string;
}

export type DockerImageInspect = (args: string[]) => Promise<DockerImageInspectResult>;

/**
 * Confirm a digest-pinned image is already local without pulling it.
 * Some Windows Docker Desktop versions do not resolve `tag@digest` in
 * `docker image inspect`; in that case inspect the local tag and compare its
 * RepoDigests entry to the configured digest.
 */
export async function isDockerImageAvailableLocally(image: string, inspect: DockerImageInspect): Promise<boolean> {
  const pinned = parsePinnedImage(image);
  if (!pinned) return false;

  if (await inspect(['image', 'inspect', image]).then(() => true, () => false)) return true;

  const taggedImage = await inspect(['image', 'inspect', '--format', '{{json .RepoDigests}}', pinned.tagReference])
    .then((result) => result.stdout, () => null);
  if (taggedImage === null) return false;

  let repoDigests: unknown;
  try { repoDigests = JSON.parse(taggedImage); } catch { return false; }
  if (!Array.isArray(repoDigests)) return false;

  return repoDigests.some((entry) => {
    if (typeof entry !== 'string') return false;
    const separator = entry.lastIndexOf('@sha256:');
    if (separator < 0) return false;
    const repository = entry.slice(0, separator);
    const digest = entry.slice(separator + '@sha256:'.length).toLowerCase();
    return digest === pinned.digest && canonicalRepository(repository) === pinned.repository;
  });
}

function parsePinnedImage(image: string): { tagReference: string; repository: string; digest: string } | null {
  const separator = image.lastIndexOf('@sha256:');
  if (separator < 1) return null;
  const tagReference = image.slice(0, separator).trim();
  const digest = image.slice(separator + '@sha256:'.length).trim().toLowerCase();
  if (!tagReference || !/^[a-f0-9]{64}$/.test(digest)) return null;

  const lastSlash = tagReference.lastIndexOf('/');
  const lastColon = tagReference.lastIndexOf(':');
  if (lastColon <= lastSlash || !tagReference.slice(lastColon + 1)) return null;
  const repository = canonicalRepository(tagReference.slice(0, lastColon));
  return { tagReference, repository, digest };
}

function canonicalRepository(repository: string): string {
  const normalized = repository.toLowerCase().replace(/\/$/, '');
  if (normalized.startsWith('docker.io/')) {
    const path = normalized.slice('docker.io/'.length);
    return path.includes('/') ? `docker.io/${path}` : `docker.io/library/${path}`;
  }
  if (!normalized.includes('/') && !normalized.includes(':')) return `docker.io/library/${normalized}`;
  const registry = normalized.slice(0, normalized.indexOf('/'));
  if (!normalized.includes('/') || (!registry.includes('.') && !registry.includes(':') && registry !== 'localhost')) {
    return `docker.io/${normalized}`;
  }
  return normalized;
}

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyWorkspaceWrite, createPinnedLookup, executeTool, parseBraveSearchResponse, parseDuckDuckGoSearchResponse, proposeWorkspacePatch, safeGet, toolsFor, validateWorkspaceWrite, workspaceWritePreview } from './tools';
import type { RuntimeTool, ToolContext } from './tools';
import type { AgentDefinition } from './registry';
import { loadRegistry } from './registry';
import type { ArtifactService } from './artifacts';
import type { MemoryService } from './memory';

describe('tool argument validation', () => {
  it('rejects incomplete JSON before a specialist tool can perform a side effect', async () => {
    let sideEffects = 0;
    const tool: RuntimeTool = {
      id: 'artifacts.create',
      schema: { type: 'function', function: { name: 'create_artifact', description: 'Create an artifact.', parameters: { type: 'object' } } },
      execute: async () => { sideEffects++; return { created: true }; },
    };

    await expect(executeTool(tool, '{"name":')).rejects.toThrow();
    expect(sideEffects).toBe(0);
  });
});

describe('workspace.write approval target', () => {
  let root: string;
  let outside: string | null = null;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-office-write-'));
    await mkdir(join(root, 'src'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    if (outside) await rm(outside, { recursive: true, force: true });
    outside = null;
  });

  it('creates a new file atomically inside the workspace', async () => {
    const result = await applyWorkspaceWrite(root, { path: 'src/hello.md', content: 'hello office' });

    expect(result.action).toBe('created');
    expect(result.checksum).toBe(createHash('sha256').update('hello office').digest('hex'));
    expect(await readFile(join(root, 'src', 'hello.md'), 'utf8')).toBe('hello office');
  });

  it('requires the exact current checksum before replacing a file', async () => {
    const target = join(root, 'src', 'existing.txt');
    await writeFile(target, 'original');
    const originalHash = createHash('sha256').update('original').digest('hex');

    await expect(validateWorkspaceWrite(root, { path: 'src/existing.txt', content: 'changed' })).rejects.toThrow('expectedChecksum');
    await expect(applyWorkspaceWrite(root, { path: 'src/existing.txt', content: 'changed', expectedChecksum: '0'.repeat(64) })).rejects.toThrow('khớp nội dung hiện tại');
    expect(await readFile(target, 'utf8')).toBe('original');

    const actualHash = createHash('sha256').update('original').digest('hex');
    expect(actualHash).toBe(originalHash);
    const replaced = await applyWorkspaceWrite(root, { path: 'src/existing.txt', content: 'changed', expectedChecksum: originalHash });
    expect(replaced.action).toBe('replaced');
    expect(await readFile(target, 'utf8')).toBe('changed');
  });

  it('captures a bounded, checksum-matched before snapshot for approval diff review', async () => {
    const target = join(root, 'src', 'reviewed.txt');
    const original = 'owner version\nkeep this line\n';
    await writeFile(target, original);
    const checksum = createHash('sha256').update(original).digest('hex');

    await expect(workspaceWritePreview(root, { path: 'src/new.txt', content: 'new file\n' }))
      .resolves.toEqual({ previewBaseContent: '', previewBaseAvailable: true });
    await expect(workspaceWritePreview(root, { path: 'src/reviewed.txt', content: 'agent version\nkeep this line\n', expectedChecksum: checksum }))
      .resolves.toEqual({ previewBaseContent: original, previewBaseAvailable: true });
    await expect(workspaceWritePreview(root, { path: 'src/reviewed.txt', content: 'stale proposal\n', expectedChecksum: '0'.repeat(64) }))
      .rejects.toThrow('File đã thay đổi');
    await writeFile(target, Buffer.alloc(200_001, 97));
    await expect(workspaceWritePreview(root, { path: 'src/reviewed.txt', content: 'small replacement', expectedChecksum: createHash('sha256').update(Buffer.alloc(200_001, 97)).digest('hex') }))
      .resolves.toEqual({ previewBaseContent: null, previewBaseAvailable: false });
  });

  it('blocks traversal and secret paths before writing', async () => {
    await expect(validateWorkspaceWrite(root, { path: '../outside.txt', content: 'nope' })).rejects.toThrow('không hợp lệ');
    await expect(validateWorkspaceWrite(root, { path: '.env', content: 'secret' })).rejects.toThrow('không hợp lệ');
    await expect(validateWorkspaceWrite(root, { path: 'src/../outside.txt', content: 'nope' })).rejects.toThrow('không hợp lệ');
    await expect(validateWorkspaceWrite(root, { path: 'src/secret.txt:stream', content: 'nope' })).rejects.toThrow('không hợp lệ');
    await expect(validateWorkspaceWrite(root, { path: 'src/CON.txt', content: 'nope' })).rejects.toThrow('không hợp lệ');
    await expect(validateWorkspaceWrite(root, { path: 'C:\\Windows\\win.ini', content: 'nope' })).rejects.toThrow('không hợp lệ');
    await expect(validateWorkspaceWrite(root, { path: '\\\\server\\share\\secret.txt', content: 'nope' })).rejects.toThrow('không hợp lệ');
    expect(await readFile(join(root, 'outside.txt')).catch(() => null)).toBeNull();
  });

  it('does not follow a directory symlink or junction when reading or writing workspace files', async () => {
    outside = await mkdtemp(join(tmpdir(), 'agent-office-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'outside-secret-sentinel');
    await symlink(outside, join(root, 'external-link'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(validateWorkspaceWrite(root, { path: 'external-link/secret.txt', content: 'overwrite' })).rejects.toThrow();
    const definition = { manifest: { allowedTools: ['workspace.read'] } } as AgentDefinition;
    const reader = toolsFor(definition, {
      projectId: 'project', runId: 'run', taskId: 'task', workspaceRoot: root,
      executionMode: 'disabled', artifacts: {} as ArtifactService,
    }).find((tool) => tool.id === 'workspace.read')!;
    await expect(reader.execute({ path: 'external-link/secret.txt' })).rejects.toThrow('symlink hoặc junction');
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside-secret-sentinel');
  });

  it('blocks traversal, UNC, device names and NTFS alternate streams on workspace reads and listings', async () => {
    await writeFile(join(root, 'src', 'safe.txt'), 'safe-content');
    const context = {
      projectId: 'project', runId: 'run', taskId: 'task', workspaceRoot: root,
      executionMode: 'disabled', artifacts: {} as ArtifactService,
    } as const;
    const read = toolsFor({ manifest: { allowedTools: ['workspace.read'] } } as AgentDefinition, context)
      .find((tool) => tool.id === 'workspace.read')!;
    const list = toolsFor({ manifest: { allowedTools: ['workspace.list'] } } as AgentDefinition, context)
      .find((tool) => tool.id === 'workspace.list')!;

    await expect(read.execute({ path: 'src/safe.txt' })).resolves.toMatchObject({ content: 'safe-content' });
    await expect(list.execute({ path: 'src' })).resolves.toEqual([{ name: 'safe.txt', type: 'file' }]);
    for (const path of [
      '../outside.txt', 'src/../outside.txt', 'src/secret.txt:stream', 'src/CON.txt', 'src/COM¹.txt', 'src/LPT².txt', 'src/CONIN$',
      'C:\\Windows\\win.ini', '\\\\server\\share\\secret.txt', '\\\\?\\C:\\secret.txt',
    ]) {
      await expect(read.execute({ path })).rejects.toThrow();
      await expect(list.execute({ path })).rejects.toThrow();
    }
    expect(await readFile(join(root, 'src', 'safe.txt'), 'utf8')).toBe('safe-content');
  });

  it('builds an exact patch proposal without writing and requires a fresh unique match', async () => {
    const target = join(root, 'src', 'app.ts');
    const original = 'const mode = "old";\nexport { mode };\n';
    await writeFile(target, original);
    const checksum = createHash('sha256').update(original).digest('hex');

    const proposal = await proposeWorkspacePatch(root, {
      path: 'src/app.ts', expectedChecksum: checksum,
      edits: [{ oldText: 'const mode = "old";', newText: 'const mode = "new";' }],
    });

    expect(proposal).toMatchObject({ path: 'src/app.ts', content: 'const mode = "new";\nexport { mode };\n', expectedChecksum: checksum, patchesApplied: 1, previewBaseContent: original });
    expect(await readFile(target, 'utf8')).toBe(original);
    await expect(proposeWorkspacePatch(root, {
      path: 'src/app.ts', expectedChecksum: checksum,
      edits: [{ oldText: 'mode', newText: 'value' }],
    })).rejects.toThrow('nhiều lần');
    await expect(proposeWorkspacePatch(root, {
      path: 'src/app.ts', expectedChecksum: '0'.repeat(64),
      edits: [{ oldText: 'const mode = "old";', newText: 'const mode = "new";' }],
    })).rejects.toThrow('đã thay đổi');
    expect(await readFile(target, 'utf8')).toBe(original);
  });

  it('applies an approved patch without disturbing other dirty or untracked worktree files', async () => {
    const target = join(root, 'src', 'feature.txt');
    const dirtyTracked = join(root, 'src', 'in-progress.txt');
    const untracked = join(root, 'scratch.txt');
    await writeFile(target, 'baseline feature');
    await writeFile(dirtyTracked, 'committed draft');
    execFileSync('git', ['init', '--quiet', root]);
    execFileSync('git', ['-C', root, 'add', 'src/feature.txt', 'src/in-progress.txt']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Agent Office Test', '-c', 'user.email=agent-office@example.invalid', 'commit', '--quiet', '-m', 'workspace baseline']);

    await writeFile(dirtyTracked, 'user edits that must be preserved');
    await writeFile(untracked, 'untracked user notes');
    const source = await readFile(target);
    const checksum = createHash('sha256').update(source).digest('hex');
    const proposal = await proposeWorkspacePatch(root, {
      path: 'src/feature.txt', expectedChecksum: checksum,
      edits: [{ oldText: 'baseline', newText: 'approved' }],
    });

    const result = await applyWorkspaceWrite(root, proposal);

    expect(result.action).toBe('replaced');
    expect(await readFile(target, 'utf8')).toBe('approved feature');
    expect(await readFile(dirtyTracked, 'utf8')).toBe('user edits that must be preserved');
    expect(await readFile(untracked, 'utf8')).toBe('untracked user notes');
    expect(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trimEnd().split(/\r?\n/).sort()).toEqual([
      ' M src/feature.txt',
      ' M src/in-progress.txt',
      '?? scratch.txt',
    ]);
  });
});

describe('workspace check tool policy', () => {
  const definition = { manifest: { allowedTools: ['workspace.run_checks'] } } as AgentDefinition;
  const context = { projectId: 'project', runId: 'run', taskId: 'task', workspaceRoot: 'C:\\workspace', artifacts: {} as ArtifactService };

  it('keeps process execution hidden unless an approved executor mode is explicitly enabled', () => {
    const disabled: ToolContext = { ...context, executionMode: 'disabled' };
    const docker: ToolContext = { ...context, executionMode: 'docker' };
    const enabled: ToolContext = { ...context, executionMode: 'local-trusted' };
    expect(toolsFor(definition, disabled)).toEqual([]);
    expect(toolsFor(definition, docker).map((tool) => tool.id)).toEqual(['workspace.run_checks']);
    expect(toolsFor(definition, docker)[0]?.schema.function.description).toContain('resource-limited Docker container');
    expect(toolsFor(definition, enabled).map((tool) => tool.id)).toEqual(['workspace.run_checks']);
  });
});

describe('scoped memory tools', () => {
  it('searches only granted memory scopes and routes project proposals versus run scratch notes', async () => {
    const registry = await loadRegistry(process.cwd());
    const definition = registry.definitions.get('writer')!;
    const calls: unknown[] = [];
    const memory = {
      searchAccessible: async (input: unknown) => { calls.push(['search', input]); return []; },
      proposeProjectMemory: async (input: unknown) => { calls.push(['propose', input]); return { status: 'proposed' }; },
      addRunNote: async (input: unknown) => { calls.push(['run-note', input]); return { revision: 1 }; },
    } as unknown as MemoryService;
    const context: ToolContext = {
      projectId: 'project-a', runId: 'run-a', taskId: 'task-a', workspaceRoot: null,
      executionMode: 'disabled', artifacts: {} as ArtifactService, memory, agentInstanceId: 'writer-01', agentDefinitionId: 'writer', memoryScopes: ['project', 'run'],
    };
    const tools = toolsFor(definition, context);
    const search = tools.find((entry) => entry.id === 'memory.search')!;
    const propose = tools.find((entry) => entry.id === 'memory.propose')!;

    expect(search).toBeDefined();
    expect(propose).toBeDefined();
    expect(await search.execute({ query: 'language', maxResults: 3 })).toEqual([]);
    expect(await propose.execute({ content: 'The owner confirmed a project decision.' })).toMatchObject({ status: 'proposed' });
    expect(await propose.execute({ scopeType: 'run', content: 'Temporary handoff detail.' })).toMatchObject({ revision: 1 });
    expect(calls).toEqual([
      ['search', { projectId: 'project-a', runId: 'run-a', agentDefinitionId: 'writer', scopes: ['project', 'run'], query: 'language', maxResults: 3 }],
      ['propose', { projectId: 'project-a', runId: 'run-a', taskId: 'task-a', agentInstanceId: 'writer-01', content: 'The owner confirmed a project decision.' }],
      ['run-note', { projectId: 'project-a', runId: 'run-a', taskId: 'task-a', agentInstanceId: 'writer-01', content: 'Temporary handoff detail.' }],
    ]);

    const restricted = toolsFor(definition, { ...context, memoryScopes: ['run'] });
    expect(restricted.map((entry) => entry.id)).toEqual(expect.arrayContaining(['memory.search', 'memory.propose']));
    await expect(restricted.find((entry) => entry.id === 'memory.propose')!.execute({ scopeType: 'project', content: 'Not allowed.' })).rejects.toThrow('không được cấp project memory');
  });
});

describe('research search provider', () => {
  it('unwraps DuckDuckGo result links and keeps only public HTTPS destinations', () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Fall.html&amp;rut=fixture">Node.js &amp; JavaScript docs</a>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Fall.html">Official &quot;Node.js&quot; documentation.</a>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=http%3A%2F%2Finsecure.example%2F">Insecure</a>
      <a class="result__snippet">Must be discarded.</a>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fuser%3Apass%40example.com%2F">Credential URL</a>
      <a class="result__snippet">Must also be discarded.</a>`;

    const parsed = parseDuckDuckGoSearchResponse('Node.js official documentation', html);

    expect(parsed.provider).toBe('duckduckgo');
    expect(parsed.results).toEqual([{ title: 'Node.js & JavaScript docs', url: 'https://nodejs.org/api/all.html', excerpt: 'Official "Node.js" documentation.' }]);
    expect(parsed.note).toBeUndefined();
  });

  it('normalizes only bounded HTTPS Brave results and requires a key when Brave is selected', async () => {
    const parsed = parseBraveSearchResponse('agent office', { web: { results: [
      { title: 'Official result', url: 'https://example.com/page', description: 'Useful excerpt.' },
      { title: 'Insecure result', url: 'http://example.com/', description: 'Skip HTTP.' },
      { title: 'Malformed result', url: 'not a URL', description: 'Skip invalid URL.' },
    ] } });
    const registry = await loadRegistry(process.cwd());
    const definition = registry.definitions.get('researcher')!;
    const context: ToolContext = {
      projectId: 'project-a', runId: 'run-a', taskId: 'task-a', workspaceRoot: null,
      executionMode: 'disabled', artifacts: {} as ArtifactService, research: { provider: 'brave' },
    };
    const search = toolsFor(definition, context).find((tool) => tool.id === 'research.search')!;

    expect(parsed.provider).toBe('brave');
    expect(parsed.results).toEqual([{ title: 'Official result', url: 'https://example.com/page', excerpt: 'Useful excerpt.' }]);
    await expect(search.execute({ query: 'agent office' })).rejects.toThrow('RESEARCH_BRAVE_API_KEY');
  });
});

describe('public research fetch redirects', () => {
  it('returns only the resolved addresses for the requested hostname', () => {
    const lookup = createPinnedLookup('public.example', [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
    let allAddresses: unknown;
    let address = '';
    let family = 0;
    let mismatch: Error | null = null;

    lookup('public.example', { all: true }, (error, result) => {
      expect(error).toBeNull();
      allAddresses = result;
    });
    lookup('public.example', {}, (error, result, resolvedFamily) => {
      expect(error).toBeNull();
      address = result as string;
      family = resolvedFamily ?? 0;
    });
    lookup('other.example', {}, (error) => { mismatch = error; });

    expect(allAddresses).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
    expect({ address, family }).toEqual({ address: '93.184.216.34', family: 4 });
    expect(mismatch).toMatchObject({ message: 'Hostname changed during request.' });
  });

  it('revalidates every redirect and refuses a public-to-private redirect before connecting', async () => {
    const resolvedHosts: string[] = [];
    const requestedUrls: string[] = [];
    const resolvePublicHttpsUrl = async (url: URL) => {
      resolvedHosts.push(url.hostname);
      if (url.hostname !== 'public.example') throw new Error('private destination rejected');
      return [{ address: '93.184.216.34', family: 4 as const }];
    };

    await expect(safeGet('https://public.example/start', 'text/plain', {}, {
      resolvePublicHttpsUrl,
      fetch: async (url) => {
        requestedUrls.push(url.toString());
        return new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } });
      },
    })).rejects.toThrow('private destination rejected');

    expect(resolvedHosts).toEqual(['public.example', '169.254.169.254']);
    expect(requestedUrls).toEqual(['https://public.example/start']);
  });

  it('pins each approved public redirect target and returns the final URL', async () => {
    const resolvedHosts: string[] = [];
    const requestedUrls: string[] = [];
    const dispatchers: unknown[] = [];
    const resolvePublicHttpsUrl = async (url: URL) => {
      resolvedHosts.push(url.hostname);
      return [{ address: url.hostname === 'first.example' ? '93.184.216.34' : '1.1.1.1', family: 4 as const }];
    };

    const result = await safeGet('https://first.example/start', 'text/plain', {}, {
      resolvePublicHttpsUrl,
      fetch: async (url, init) => {
        requestedUrls.push(url.toString());
        dispatchers.push(init.dispatcher);
        if (url.hostname === 'first.example') return new Response(null, { status: 302, headers: { location: 'https://second.example/final' } });
        return new Response('safe body', { status: 200, headers: { 'content-type': 'text/plain' } });
      },
    });

    expect(resolvedHosts).toEqual(['first.example', 'second.example']);
    expect(requestedUrls).toEqual(['https://first.example/start', 'https://second.example/final']);
    expect(dispatchers).toHaveLength(2);
    expect(dispatchers[0]).not.toBe(dispatchers[1]);
    expect(result).toEqual({ url: 'https://second.example/final', body: Buffer.from('safe body'), contentType: 'text/plain' });
  });

  it('does not follow a search-provider redirect with credentials attached', async () => {
    const resolvedHosts: string[] = [];
    const requested: Array<{ url: string; authorization: string | undefined }> = [];

    await expect(safeGet('https://search.example/api', 'application/json', {
      headers: { Authorization: 'Bearer provider-secret' }, followRedirects: false,
    }, {
      resolvePublicHttpsUrl: async (url) => {
        resolvedHosts.push(url.hostname);
        return [{ address: '93.184.216.34', family: 4 }];
      },
      fetch: async (url, init) => {
        const headers = init.headers as Record<string, string>;
        requested.push({ url: url.toString(), authorization: headers.Authorization });
        return new Response(null, { status: 302, headers: { location: 'https://redirect.example/steal' } });
      },
    })).rejects.toThrow('credentials were not forwarded');

    expect(resolvedHosts).toEqual(['search.example']);
    expect(requested).toEqual([{ url: 'https://search.example/api', authorization: 'Bearer provider-secret' }]);
  });
});

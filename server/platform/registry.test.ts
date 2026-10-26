import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRegistry, previewRegistryAdditions } from './registry';

describe('registry hot reload preview', () => {
  it('loads both model protocols as explicit, independent profiles', async () => {
    const registry = await loadRegistry(process.cwd());

    expect(registry.profiles.get('primary')?.protocol).toBe('chat-completions');
    expect(registry.profiles.get('primary-responses')?.protocol).toBe('responses');
  });

  it('accepts Docker as an explicit shell executor policy', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'agent-office-docker-policy-'));
    try {
      await Promise.all(['agents', 'config', 'skills'].map((name) => cp(join(process.cwd(), name), join(temp, name), { recursive: true })));
      const policyPath = join(temp, 'config', 'policies.yaml');
      const policyText = (await readFile(policyPath, 'utf8')).replace('shell: local-trusted', 'shell: docker');
      await writeFile(policyPath, policyText);

      const registry = await loadRegistry(temp);

      expect(registry.policy.approvals.shell).toBe('docker');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('loads an owner-priced model profile with an explicit model ID and price version', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'agent-office-model-pricing-'));
    try {
      await Promise.all(['agents', 'config', 'skills'].map((name) => cp(join(process.cwd(), name), join(temp, name), { recursive: true })));
      const modelPath = join(temp, 'config', 'models.yaml');
      const source = (await readFile(modelPath, 'utf8')).replace(/\r\n/g, '\n');
      const withoutPricing = source.replace(/\n    pricing:\n      version: [^\n]*\n      modelName: [^\n]*\n      inputUsdPerMillionTokens: [^\n]*\n      outputUsdPerMillionTokens: [^\n]*/g, '');
      await writeFile(modelPath, withoutPricing.replace(
        'capabilityRequirements: [tool-calling, streaming]',
        'capabilityRequirements: [tool-calling, streaming]\n    pricing:\n      version: owner-2026-10\n      modelName: exact-model-from-env\n      inputUsdPerMillionTokens: 0.2\n      outputUsdPerMillionTokens: 0.8',
      ));

      const registry = await loadRegistry(temp);

      expect(registry.profiles.get('primary')?.pricing).toEqual({
        version: 'owner-2026-10', modelName: 'exact-model-from-env', inputUsdPerMillionTokens: 0.2, outputUsdPerMillionTokens: 0.8,
      });
      expect(registry.profiles.get('coding')?.pricing).toBeUndefined();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('accepts an explicitly configured zero price without treating missing pricing as zero', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'agent-office-free-model-pricing-'));
    try {
      await Promise.all(['agents', 'config', 'skills'].map((name) => cp(join(process.cwd(), name), join(temp, name), { recursive: true })));
      const modelPath = join(temp, 'config', 'models.yaml');
      const source = (await readFile(modelPath, 'utf8')).replace(/\r\n/g, '\n');
      const withoutPricing = source.replace(/\n    pricing:\n      version: [^\n]*\n      modelName: [^\n]*\n      inputUsdPerMillionTokens: [^\n]*\n      outputUsdPerMillionTokens: [^\n]*/g, '');
      await writeFile(modelPath, withoutPricing.replace(
        'capabilityRequirements: [tool-calling, streaming]',
        'capabilityRequirements: [tool-calling, streaming]\n    pricing:\n      version: owner-free-2026-10\n      modelName: confirmed-free-model\n      inputUsdPerMillionTokens: 0\n      outputUsdPerMillionTokens: 0',
      ));

      const registry = await loadRegistry(temp);

      expect(registry.profiles.get('primary')?.pricing).toEqual({
        version: 'owner-free-2026-10', modelName: 'confirmed-free-model', inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0,
      });
      expect(registry.profiles.get('coding')?.pricing).toBeUndefined();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('allows an append-only specialist definition and roster entry', async () => {
    const current = await loadRegistry(process.cwd());
    const candidate = {
      ...current,
      definitions: new Map(current.definitions),
      roster: [...current.roster],
      skills: new Map(current.skills),
      profiles: new Map(current.profiles),
      tools: new Map(current.tools),
      revision: 'candidate-revision',
    };
    const writer = current.definitions.get('writer')!;
    candidate.definitions.set('designer', {
      ...writer,
      manifest: { ...writer.manifest, id: 'designer', version: '1.0.0', displayName: 'Designer' },
      configHash: 'new-designer-definition',
    });
    candidate.roster.push({ id: 'designer-01', definition: 'designer', displayName: 'Designer', enabled: true, appearanceSeed: 74001 });

    const diff = previewRegistryAdditions(current, candidate);

    expect(diff.canApply).toBe(true);
    expect(diff.blockers).toEqual([]);
    expect(diff.addedDefinitions.map((definition) => definition.id)).toEqual(['designer']);
    expect(diff.addedAgents.map((agent) => agent.id)).toEqual(['designer-01']);
  });

  it('blocks changes to an installed definition', async () => {
    const current = await loadRegistry(process.cwd());
    const candidate = { ...current, definitions: new Map(current.definitions), revision: 'changed-revision' };
    const writer = current.definitions.get('writer')!;
    candidate.definitions.set('writer', { ...writer, configHash: 'changed-writer-definition' });

    const diff = previewRegistryAdditions(current, candidate);

    expect(diff.canApply).toBe(false);
    expect(diff.blockers).toContain('Definition writer đã thay đổi; cập nhật definition hiện có cần khởi động lại.');
  });
});

import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { loadAppConfig, redactedConfig } from './config';

describe('research provider configuration', () => {
  it('defaults to keyless DuckDuckGo and never includes provider credentials in redacted config', () => {
    const config = loadAppConfig({});
    expect(config.research).toMatchObject({ provider: 'duckduckgo', configured: true });
    expect(JSON.stringify(redactedConfig(config))).not.toContain('apiKey');
  });

  it('supports an owner-selected agent configuration directory for restored or portable setups', () => {
    const selectedConfigDir = resolve(tmpdir(), 'AgentOffice', 'configuration');
    const config = loadAppConfig({ OFFICE_CONFIG_DIR: selectedConfigDir });
    expect(config.configDir).toBe(selectedConfigDir);
    expect(redactedConfig(config)).toMatchObject({ configDir: config.configDir });
  });

  it('reports Brave as unconfigured without a key and redacts a configured key', () => {
    const missing = loadAppConfig({ OFFICE_RESEARCH_PROVIDER: 'brave' });
    const configured = loadAppConfig({ OFFICE_RESEARCH_PROVIDER: 'brave', RESEARCH_BRAVE_API_KEY: 'brave-test-secret' });

    expect(missing.research).toMatchObject({ provider: 'brave', configured: false, apiKey: '' });
    expect(configured.research).toMatchObject({ provider: 'brave', configured: true, apiKey: 'brave-test-secret' });
    expect(JSON.stringify(redactedConfig(configured))).not.toContain('brave-test-secret');
  });

  it('validates explicit Docker execution settings and exposes them without secrets', () => {
    const config = loadAppConfig({
      OFFICE_EXECUTION_MODE: 'docker',
      OFFICE_DOCKER_IMAGE: 'node:22.12.0-bookworm-slim@sha256:35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213',
      OFFICE_DOCKER_INSTALL_DEPENDENCIES: 'npm-ci',
      OFFICE_DOCKER_NETWORK: 'bridge',
      OFFICE_DOCKER_MEMORY_MB: '1024',
      OFFICE_DOCKER_CPUS: '1.5',
      OFFICE_DOCKER_PIDS_LIMIT: '64',
    });
    expect(config).toMatchObject({
      executionMode: 'docker',
      docker: { image: 'node:22.12.0-bookworm-slim@sha256:35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213', network: 'bridge', installDependencies: 'npm-ci', memoryMb: 1024, cpus: 1.5, pidsLimit: 64 },
    });
    expect(redactedConfig(config)).toMatchObject({ executionMode: 'docker', docker: config.docker });
    expect(() => loadAppConfig({ OFFICE_DOCKER_IMAGE: 'node image;echo unsafe' })).toThrow('Cấu hình Agent Office không hợp lệ');
    expect(() => loadAppConfig({ OFFICE_DOCKER_IMAGE: 'node:22.12.0-bookworm-slim' })).toThrow('Cấu hình Agent Office không hợp lệ');
    expect(() => loadAppConfig({ OFFICE_DOCKER_CPUS: '0.1' })).toThrow('Cấu hình Agent Office không hợp lệ');
    expect(() => loadAppConfig({ OFFICE_DOCKER_INSTALL_DEPENDENCIES: 'npm-ci', OFFICE_DOCKER_NETWORK: 'none' })).toThrow('Cấu hình Agent Office không hợp lệ');
  });
});

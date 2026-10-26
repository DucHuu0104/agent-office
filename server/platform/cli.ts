import { loadAppConfig, profileEnvValue, redactedConfig } from './config';
import { ChatCompletionsGateway } from './models/chat-completions';
import { ResponsesGateway } from './models/responses';
import { createBackupBundle, createDatabaseBackup, inspectStorage, restoreBackupBundle, restoreDatabaseBackup } from './operations';
import { loadRegistry } from './registry';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const development = import.meta.url.endsWith('.ts');

export interface CliOutput {
  stdout(message: string): void;
  stderr(message: string): void;
}

/** Execute commands against explicit inputs so behavior can be tested without child-process side effects. */
export async function runCli(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, output: CliOutput = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
}): Promise<number> {
  try {
    await main(args, env, output);
    return 0;
  } catch (error) {
    output.stderr(error instanceof Error ? error.message : 'Không thể kiểm tra cấu hình.');
    return 1;
  }
}

async function main(args: string[], env: NodeJS.ProcessEnv, output: CliOutput): Promise<void> {
  const command = args[0] ?? 'validate';
  const config = loadAppConfig(env);
  const registry = await loadRegistry(config.configDir);
  const coordinator = registry.definitions.get('coordinator')!;
  const profileId = optionValue(args, '--profile') ?? coordinator.manifest.modelProfile;
  const modelProfile = registry.profiles.get(profileId);
  if (!modelProfile) throw new Error(`Không tìm thấy model profile trong registry: ${profileId}.`);
  const modelOptions = {
    baseUrl: profileEnvValue(env, modelProfile.baseUrlEnv, 'MODEL_PRIMARY_BASE_URL', config.model.baseUrl).replace(/\/+$/, ''),
    apiKey: profileEnvValue(env, modelProfile.apiKeyEnv, 'MODEL_PRIMARY_API_KEY', config.model.apiKey),
    model: profileEnvValue(env, modelProfile.modelEnv, 'MODEL_PRIMARY_NAME', config.model.name),
  };
  const chatConfigured = !!modelOptions.baseUrl.trim() && !!modelOptions.apiKey.trim() && !!modelOptions.model.trim();
  const modelProfiles = [...registry.profiles.values()].map((profile) => {
    const baseUrl = profileEnvValue(env, profile.baseUrlEnv, 'MODEL_PRIMARY_BASE_URL', config.model.baseUrl);
    const model = profileEnvValue(env, profile.modelEnv, 'MODEL_PRIMARY_NAME', config.model.name);
    const apiKey = profileEnvValue(env, profile.apiKeyEnv, 'MODEL_PRIMARY_API_KEY', config.model.apiKey);
    return { id: profile.id, protocol: profile.protocol, model: model || null, configured: !!baseUrl && !!apiKey && !!model };
  });
  const result = {
    ok: true,
    configuration: redactedConfig(config),
    registry: {
      revision: registry.revision,
      definitions: [...registry.definitions.keys()].sort(),
      roster: registry.roster.map(({ id, definition, displayName, enabled }) => ({ id, definition, displayName, enabled })),
      skills: [...registry.skills.keys()].sort(),
      tools: [...registry.tools.keys()].sort(),
      profiles: [...registry.profiles.keys()].sort(),
    },
    research: { provider: config.research.provider, configured: config.research.configured },
    model: chatConfigured ? 'configured' : 'missing credentials or model name',
    modelProfiles,
  };
  if (command === 'validate' || command === 'config:validate') {
    output.stdout(JSON.stringify(result, null, 2));
    if (!config.model.configured) output.stdout('Lưu ý: registry hợp lệ; model chưa sẵn sàng cho chat live.');
    return;
  }
  if (command === 'doctor' && args.includes('--live')) {
    if (!chatConfigured) throw new Error(`Model chưa được cấu hình cho profile ${modelProfile.id}. Hãy điền ${modelProfile.baseUrlEnv}, ${modelProfile.apiKeyEnv} và ${modelProfile.modelEnv} trong .env.`);
    if (args.includes('--tools') && !modelProfile.capabilityRequirements.includes('tool-calling')) {
      throw new Error(`Model profile ${modelProfile.id} không khai báo khả năng tool-calling.`);
    }
    const storage = await inspectStorage(config.dataDir, development);
    const toolProbe = args.includes('--tools');
    const Gateway = modelProfile.protocol === 'responses' ? ResponsesGateway : ChatCompletionsGateway;
    const gateway = new Gateway({
      baseUrl: modelOptions.baseUrl,
      apiKey: modelOptions.apiKey,
      model: modelOptions.model,
      maxOutputTokens: toolProbe ? 128 : 64,
      timeoutSeconds: 30,
    });
    const reply = await gateway.complete({ messages: [
      { role: 'system', content: toolProbe ? 'Call the ping tool once with value "READY".' : 'Reply with the single word READY.' },
      { role: 'user', content: toolProbe ? 'Connection and function-call check.' : 'Connection check. Reply READY.' },
    ], ...(toolProbe ? {
      tools: [{ type: 'function' as const, function: { name: 'ping', description: 'Return the readiness word.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } }],
      // Some Responses providers reject a forced function-choice object. `required` still proves
      // actual tool calling because this probe declares only the ping function and validates its arguments.
      toolChoice: modelProfile.protocol === 'responses' ? 'required' : { type: 'function' as const, function: { name: 'ping' } },
    } : {}) });
    if (toolProbe) {
      const pingReturned = reply.toolCalls.some(({ name, arguments: raw }) => {
        if (name !== 'ping') return false;
        try { return (JSON.parse(raw) as { value?: unknown }).value === 'READY'; }
        catch { return false; }
      });
      if (!pingReturned) throw new Error('Model phản hồi nhưng chưa vượt qua probe function-call ping.');
    } else if (!reply.content.trim().toUpperCase().includes('READY')) {
      throw new Error('Model endpoint phản hồi nhưng nội dung không đúng với probe READY.');
    }
    output.stdout(JSON.stringify({ ok: true, storage, registryRevision: registry.revision, modelProfile: modelProfile.id, model: modelOptions.model, responseReceived: true, toolCalling: toolProbe ? reply.toolCalls.map(({ name, arguments: toolArguments }) => ({ name, arguments: toolArguments })) : 'not checked', finishReason: reply.finishReason, usage: reply.usage }));
    return;
  }
  if (command === 'doctor') {
    const storage = await inspectStorage(config.dataDir, development);
    output.stdout(JSON.stringify({ ...result, storage, readiness: { registryReady: !!registry.definitions.get('coordinator'), chatConfigured, modelProfile: modelProfile.id, researchConfigured: config.research.configured, executionMode: config.executionMode }, liveModelCheck: 'not run; use npm run office:doctor -- --live [--profile <id>] to make an explicit provider request' }, null, 2));
    return;
  }
  if (command === 'backup') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = optionValue(args, '--to') ?? `${config.dataDir}/backups/agent-office-${timestamp}.aobackup`;
    const backup = await createBackupBundle(config.dataDir, destination, config.configDir, development);
    output.stdout(JSON.stringify({ ok: true, backup }, null, 2));
    return;
  }
  if (command === 'restore') {
    const source = requiredOption(args, '--from');
    const destinationDataDir = requiredOption(args, '--to-data-dir');
    const sourceInfo = await lstat(source);
    if (sourceInfo.isSymbolicLink()) throw new Error('Không thể khôi phục từ symlink hoặc junction.');
    if (sourceInfo.isDirectory()) {
      const restored = await restoreBackupBundle(source, destinationDataDir, development);
      output.stdout(JSON.stringify({ ok: true, restored, nextStep: `Set OFFICE_DATA_DIR=${restored.dataDir} and OFFICE_CONFIG_DIR=${restored.configDir} in .env before starting Agent Office.` }, null, 2));
    } else {
      const restored = await restoreDatabaseBackup(source, destinationDataDir, development);
      output.stdout(JSON.stringify({ ok: true, restored, nextStep: `Set OFFICE_DATA_DIR=${restored.dataDir} in .env before starting Agent Office. This legacy SQLite backup does not include artifacts or agent configuration.` }, null, 2));
    }
    return;
  }
  throw new Error(`Lệnh không hỗ trợ: ${command}. Dùng validate, doctor, backup ou restore.`);
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith('--')) throw new Error(`Cần cung cấp giá trị cho ${name}.`);
  return value;
}

function requiredOption(args: string[], name: string): string {
  const value = optionValue(args, name);
  if (!value) throw new Error(`Cần truyền ${name}.`);
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void runCli().then((code) => { process.exitCode = code; });
}

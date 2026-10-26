import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  OFFICE_HOST: z.literal('127.0.0.1').default('127.0.0.1'),
  OFFICE_PORT: z.coerce.number().int().min(1024).max(65535).default(4849),
  OFFICE_DATA_DIR: z.string().default(''),
  OFFICE_CONFIG_DIR: z.string().default(''),
  OFFICE_DEFAULT_LOCALE: z.enum(['vi', 'en']).default('vi'),
  OFFICE_EXECUTION_MODE: z.enum(['disabled', 'docker', 'local-trusted']).default('disabled'),
  OFFICE_DOCKER_IMAGE: z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/).refine((value) => /@sha256:[a-f0-9]{64}$/i.test(value), 'Docker image must be pinned by sha256 digest.').default('node:22.12.0-bookworm-slim@sha256:35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213'),
  OFFICE_DOCKER_NETWORK: z.enum(['none', 'bridge']).default('none'),
  OFFICE_DOCKER_INSTALL_DEPENDENCIES: z.enum(['none', 'npm-ci']).default('none'),
  OFFICE_DOCKER_MEMORY_MB: z.coerce.number().int().min(256).max(16384).default(2048),
  OFFICE_DOCKER_CPUS: z.coerce.number().min(0.25).max(8).multipleOf(0.25).default(2),
  OFFICE_DOCKER_PIDS_LIMIT: z.coerce.number().int().min(32).max(1024).default(128),
  OFFICE_MAX_RUNNING_EXECUTIONS: z.coerce.number().int().min(1).max(16).default(4),
  OFFICE_MAX_SPECIALIST_EXECUTIONS: z.coerce.number().int().min(1).max(12).default(3),
  OFFICE_RESEARCH_PROVIDER: z.enum(['duckduckgo', 'brave']).default('duckduckgo'),
  RESEARCH_BRAVE_API_KEY: z.string().default(''),
  MODEL_PRIMARY_BASE_URL: z.string().default('https://api.openai.com/v1'),
  MODEL_PRIMARY_API_KEY: z.string().default(''),
  MODEL_PRIMARY_NAME: z.string().default(''),
}).superRefine((values, context) => {
  if (values.OFFICE_DOCKER_INSTALL_DEPENDENCIES === 'npm-ci' && values.OFFICE_DOCKER_NETWORK !== 'bridge') {
    context.addIssue({ code: 'custom', path: ['OFFICE_DOCKER_NETWORK'], message: 'npm ci cần OFFICE_DOCKER_NETWORK=bridge để tải dependencies.' });
  }
});

export interface AppConfig {
  host: '127.0.0.1';
  port: number;
  dataDir: string;
  configDir: string;
  locale: 'vi' | 'en';
  executionMode: 'disabled' | 'docker' | 'local-trusted';
  docker: { image: string; network: 'none' | 'bridge'; installDependencies: 'none' | 'npm-ci'; memoryMb: number; cpus: number; pidsLimit: number };
  maxRunningExecutions: number;
  maxSpecialistExecutions: number;
  research: { provider: 'duckduckgo' | 'brave'; apiKey: string; configured: boolean };
  model: { baseUrl: string; apiKey: string; name: string; configured: boolean };
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Cấu hình Agent Office không hợp lệ: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const values = parsed.data;
  const baseUrl = values.MODEL_PRIMARY_BASE_URL.trim().replace(/\/+$/, '');
  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw new Error('MODEL_PRIMARY_BASE_URL phải là URL hợp lệ.');
  }
  const loopback = endpoint.hostname === '127.0.0.1' || endpoint.hostname === 'localhost' || endpoint.hostname === '[::1]';
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) {
    throw new Error('Model endpoint phải dùng HTTPS; HTTP chỉ được phép cho model loopback.');
  }
  const dataDir = values.OFFICE_DATA_DIR.trim()
    ? resolve(values.OFFICE_DATA_DIR.trim())
    : resolve(process.env.LOCALAPPDATA || homedir(), 'AgentOffice');
  const configDir = values.OFFICE_CONFIG_DIR.trim() ? resolve(values.OFFICE_CONFIG_DIR.trim()) : resolve(process.cwd());
  if (!isAbsolute(dataDir)) throw new Error('OFFICE_DATA_DIR phải là đường dẫn tuyệt đối.');
  return {
    host: values.OFFICE_HOST,
    port: values.OFFICE_PORT,
    dataDir,
    configDir,
    locale: values.OFFICE_DEFAULT_LOCALE,
    executionMode: values.OFFICE_EXECUTION_MODE,
    docker: {
      image: values.OFFICE_DOCKER_IMAGE,
      network: values.OFFICE_DOCKER_NETWORK,
      installDependencies: values.OFFICE_DOCKER_INSTALL_DEPENDENCIES,
      memoryMb: values.OFFICE_DOCKER_MEMORY_MB,
      cpus: values.OFFICE_DOCKER_CPUS,
      pidsLimit: values.OFFICE_DOCKER_PIDS_LIMIT,
    },
    maxRunningExecutions: values.OFFICE_MAX_RUNNING_EXECUTIONS,
    maxSpecialistExecutions: values.OFFICE_MAX_SPECIALIST_EXECUTIONS,
    research: {
      provider: values.OFFICE_RESEARCH_PROVIDER,
      apiKey: values.RESEARCH_BRAVE_API_KEY.trim(),
      configured: values.OFFICE_RESEARCH_PROVIDER === 'duckduckgo' || !!values.RESEARCH_BRAVE_API_KEY.trim(),
    },
    model: {
      baseUrl,
      apiKey: values.MODEL_PRIMARY_API_KEY.trim(),
      name: values.MODEL_PRIMARY_NAME.trim(),
      configured: !!values.MODEL_PRIMARY_API_KEY.trim() && !!values.MODEL_PRIMARY_NAME.trim(),
    },
  };
}

export function redactedConfig(config: AppConfig): Record<string, unknown> {
  return {
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    configDir: config.configDir,
    locale: config.locale,
    executionMode: config.executionMode,
    docker: config.docker,
    maxRunningExecutions: config.maxRunningExecutions,
    maxSpecialistExecutions: config.maxSpecialistExecutions,
    research: { provider: config.research.provider, configured: config.research.configured },
    model: { baseUrl: config.model.baseUrl, name: config.model.name, configured: config.model.configured },
  };
}

export function profileEnvValue(env: NodeJS.ProcessEnv, environmentName: string, primaryName: string, primaryFallback: string): string {
  const configured = env[environmentName]?.trim();
  return configured || (environmentName === primaryName ? primaryFallback : '');
}

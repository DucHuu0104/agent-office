import { register } from 'tsx/esm/api';

register();
await import('./db-worker.ts');

import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'dist/client');
const secrets = Object.entries(process.env)
  .filter(([name, value]) => value && /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(name))
  .map(([name, value]) => ({ name, value: Buffer.from(value) }));

if (secrets.length === 0) {
  throw new Error('No secret-like environment variables were provided; set test sentinels before scanning the client bundle.');
}

let filesScanned = 0;
const findings = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Client bundle contains a symbolic link: ${path}`);
    if (entry.isDirectory()) {
      await walk(path);
    } else if (entry.isFile()) {
      filesScanned += 1;
      const contents = await readFile(path);
      for (const secret of secrets) {
        if (contents.indexOf(secret.value) !== -1) findings.push({ name: secret.name, path });
      }
    } else {
      throw new Error(`Client bundle contains an unsupported entry: ${path}`);
    }
  }
}

await walk(root);
if (findings.length > 0) {
  const details = findings.map(({ name, path }) => `${name} in ${path}`).join('\n');
  throw new Error(`Secret sentinel found in browser bundle:\n${details}`);
}

console.log(`Scanned ${filesScanned} browser bundle files against ${secrets.length} secret sentinels; no matches.`);

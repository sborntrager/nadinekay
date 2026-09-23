import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const database = process.argv[2];
const remote = process.argv.includes('--remote');

if (!database) {
  console.error('Usage: npm run db:setup -- <database-name> [--remote]');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrations = [
  'modules/cloudflare-magic-link-auth/migrations/0001_auth.sql',
  'modules/catalog-and-media-admin/migrations/0001_catalog.sql',
  'modules/catalog-and-media-admin/migrations/0002_product_skus.sql',
  'modules/quote-to-order-workflow/migrations/0001_quotes_orders.sql',
  'migrations/0001_nadine_kay_seed.sql',
];

for (const relativeFile of migrations) {
  const file = path.join(root, relativeFile);
  const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
  const args = [wrangler, 'd1', 'execute', database, remote ? '--remote' : '--local', '--file', file];
  if (!remote) args.push('--config', path.join(root, 'wrangler.local.jsonc'));
  console.log(`Applying ${relativeFile} to ${database} (${remote ? 'remote' : 'local'})`);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log('Database setup complete.');

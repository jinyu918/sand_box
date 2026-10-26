import { build } from 'esbuild';

await build({
  entryPoints: ['src/broker/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'dist/broker.cjs',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});

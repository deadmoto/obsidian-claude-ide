import { build, context } from 'esbuild';
import process from 'node:process';
import path from 'node:path';

const watch = process.argv.includes('--watch');

const common = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'node-pty'],
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  minify: false,
  outfile: path.join('dist', 'main.js'),
  treeShaking: true,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production')
  },
  plugins: [
    {
      name: 'no-watch-plugin',
      setup(build) {
        build.onStart(() => {
          console.log('[obsidian-claude-ide] Building plugin bundle...');
        });
      }
    }
  ]
};

if (watch) {
  const ctx = await context(common);
  await ctx.watch();
  console.log('[obsidian-claude-ide] watch mode started');
} else {
  await build(common);
}

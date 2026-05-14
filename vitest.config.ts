import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      obsidian: path.resolve(__dirname, 'tests/mocks/obsidian.ts')
    }
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/unit/**/*.ts', 'src/**/*.test.ts'],
    coverage: {
      reporter: ['text'],
      include: ['src/**/*.ts']
    }
  }
});

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  // Bundle workspace packages; keep native / large deps external.
  noExternal: [/^@ttysage\//],
  external: ['node-pty', '@xterm/headless', '@modelcontextprotocol/sdk', '@anthropic-ai/sdk', 'zod'],
  banner: { js: '#!/usr/bin/env node' },
});

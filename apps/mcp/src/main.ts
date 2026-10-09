import { startMcpServer } from './index';

startMcpServer().catch((err: unknown) => {
  process.stderr.write(`ttysage-mcp: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});

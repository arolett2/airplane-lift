// Print the external-reference benchmark table: `npm run benchmark` (add `-- --markdown` for a
// Markdown table). Loads the TypeScript physics through Vite's SSR loader, so no build is needed.
import { createServer } from 'vite';

const server = await createServer({
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});
let failed;
try {
  const report = await server.ssrLoadModule('/src/physics/benchmarks/report.ts');
  const results = report.evaluateAll();
  const markdown = process.argv.includes('--markdown');
  console.log(markdown ? report.formatMarkdown(results) : report.formatTable(results));
  failed = results.filter((c) => !c.pass && !c.knownDeviation).length;
} finally {
  await server.close();
}
process.exitCode = failed > 0 ? 1 : 0;

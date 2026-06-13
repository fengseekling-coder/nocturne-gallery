#!/usr/bin/env node
/**
 * Run perf harness headless and write test-results/performance-report.json
 * Requires: npm run dev (or PLAYWRIGHT base URL) on http://localhost:1420
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPerformanceTests } from './performance-test.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'test-results');
const outFile = path.join(outDir, 'performance-report.json');

async function main() {
  const report = await runPerformanceTests({ headless: true });

  if (!report) {
    console.error('Performance run failed; no report written.');
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\n📄 Report written: ${path.relative(root, outFile)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
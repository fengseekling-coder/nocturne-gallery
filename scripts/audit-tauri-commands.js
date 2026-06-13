#!/usr/bin/env node
/**
 * Compare frontend invoke('…') names with src-tauri invoke_handler registration.
 * Exit 0 when every frontend invoke has a registered backend command.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function walk(dir, extRe, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, extRe, out);
    else if (extRe.test(name)) out.push(p);
  }
  return out;
}

function collectFrontendInvokes() {
  const srcDir = path.join(root, 'src');
  const files = walk(srcDir, /\.(ts|tsx)$/);
  const names = new Set();
  const invokeRe = /invoke\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`]+)['"`]/g;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = invokeRe.exec(text)) !== null) {
      names.add(m[1]);
    }
  }
  return [...names].sort();
}

function collectRegisteredCommands() {
  const libRs = path.join(root, 'src-tauri', 'src', 'lib.rs');
  const text = fs.readFileSync(libRs, 'utf8');
  const block = text.match(/generate_handler!\[\s*([\s\S]*?)\]\s*\)/);
  if (!block) {
    console.error('Could not find generate_handler! in src-tauri/src/lib.rs');
    process.exit(2);
  }
  const registered = new Set();
  for (const line of block[1].split('\n')) {
    const trimmed = line.replace(/\/\/.*$/, '').trim().replace(/,$/, '');
    if (!trimmed || trimmed.startsWith('//')) continue;
    const modFn = trimmed.match(/commands::[\w:]+::(\w+)/);
    if (modFn) {
      registered.add(modFn[1]);
      continue;
    }
    const ident = trimmed.match(/^([a-z][a-z0-9_]*)$/i);
    if (ident) registered.add(ident[1]);
  }
  return [...registered].sort();
}

const frontend = collectFrontendInvokes();
const backend = new Set(collectRegisteredCommands());

const missingOnBackend = frontend.filter((n) => !backend.has(n));
const unusedOnFrontend = [...backend].filter(
  (n) => !frontend.includes(n) && !n.startsWith('scan_') && n !== 'scan_directory',
);

console.log('=== Tauri invoke audit ===\n');
console.log(`Frontend invoke calls: ${frontend.length}`);
console.log(`Registered commands: ${backend.size}\n`);

if (missingOnBackend.length) {
  console.error('MISSING on backend (frontend calls with no handler):');
  for (const n of missingOnBackend) console.error(`  - ${n}`);
  console.error('');
  process.exit(1);
}

console.log('OK: Every frontend invoke has a registered Rust command.\n');
console.log(
  'Note: Many registered commands are only used from Rust or future UI — not listed as errors.',
);
process.exit(0);
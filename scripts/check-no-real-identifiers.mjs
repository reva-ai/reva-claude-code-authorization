#!/usr/bin/env node
// This repository is public. Nothing that identifies a real deployment, a real
// person, or a real credential may land in it — including in comments, tests
// and example payloads.
//
// Written in Node rather than grep because backreferences are not portable
// across grep implementations, and because the allowlist below needs to be
// readable by whoever trips it.
//
// Complements the gitleaks job rather than replacing it: this check knows this
// project (our internal hostnames, our token shapes, our own default host),
// gitleaks knows the wider world's credential formats.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = process.cwd();

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.github']);
const SKIP_EXT = new Set(['.png', '.jpg', '.gif', '.svg', '.ico', '.lock']);
const SKIP_FILES = new Set(['package-lock.json', 'check-no-real-identifiers.mjs']);

// The only reva.ai hosts allowed to appear anywhere.
//   api.reva.ai        the shipped production default (src/config.ts)
//   api.example.reva.ai   the documentation placeholder
//   reva.ai / docs.reva.ai   public marketing and docs
const RULES = [
  {
    name: 'internal Reva environment hostname',
    // pr06/dv06-style environment hosts, and anything under dev./preview.
    re: /\b[a-z0-9-]*\.?(?:pr\d{2}|dv\d{2})\.(?:preview|dev)\.reva\.ai\b|\b[a-z0-9-]+\.(?:preview|dev)\.reva\.ai\b/gi,
    hint: 'use api.example.reva.ai in docs and tests',
  },
  {
    name: 'private GitLab remote',
    re: /gitlab\.com[:/]reva\.ai\b|\bpm_demo\b/gi,
    hint: 'this package is distributed from its public GitHub repository',
  },
  {
    name: 'JWT or JWE literal',
    re: /\beyJ[A-Za-z0-9_-]{10,}/g,
    hint: 'never commit a token, even an expired one',
  },
  {
    name: 'AWS access key id',
    re: /\bAKIA[0-9A-Z]{12,}\b/g,
    hint: 'rotate it now if this was ever real',
  },
  {
    name: 'GitHub token',
    re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    hint: 'rotate it now if this was ever real',
  },
  {
    name: 'private key block',
    re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    hint: 'never commit a key',
  },
  {
    name: 'real-looking email address',
    // Any address that is not one of ours-by-design or an obvious placeholder.
    re: /\b[A-Za-z0-9._%+-]+@(?!example\.|reva\.ai\b|test\.|localhost)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    hint: 'use dev@example.com, or info@reva.ai for real contact details',
  },
];

// Substrings that make a match legitimate. Keep this short and justified.
const ALLOW = [
  'noreply@anthropic.com',      // commit trailer
  '@types/node',                // npm scope, not an email
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full, out);
    } else if (!SKIP_EXT.has(extname(entry)) && !SKIP_FILES.has(entry)) {
      out.push(full);
    }
  }
  return out;
}

let failures = 0;
for (const file of walk(ROOT)) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;                    // binary or unreadable — nothing to check
  }
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const match of text.matchAll(rule.re)) {
      if (ALLOW.some((a) => match[0].includes(a))) continue;
      const line = text.slice(0, match.index).split('\n').length;
      console.error(
        `${relative(ROOT, file)}:${line}  ${rule.name}: ${match[0]}\n    ${rule.hint}`,
      );
      failures++;
    }
  }
}

if (failures) {
  console.error(`\n${failures} disallowed identifier(s) found. This repository is public.`);
  process.exit(1);
}
console.log('No real identifiers found.');

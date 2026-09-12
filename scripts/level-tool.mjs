#!/usr/bin/env node
/**
 * Level tool: strict validation of level JSON against src/world/level.d.ts and thumbnail
 * prerendering, from the command line (Node ≥ 18, no dependencies).
 *
 *   node scripts/level-tool.mjs [options] <level.json | directory>...
 *
 *   --out <dir>     where thumbnails go (default: thumbnails/)
 *   --scale <n>     pixels per voxel edge (default: 6)
 *   --no-render     validate only
 *   --strict        warnings count as failures
 *   --campaign      also validate and render the generated campaign (12 levels)
 *   --json          print the report as JSON instead of text
 *
 * Exit code 1 when any level has errors (or warnings with --strict).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { validateLevel } from './level-validate.mjs';
import { renderThumbnails } from './level-render.mjs';
import { buildCampaignLevel, CAMPAIGN_LENGTH } from '../src/world/level-builder.js';

const USAGE = `Usage: node scripts/level-tool.mjs [options] <level.json | directory>...
  --out <dir>     where thumbnails go (default: thumbnails/)
  --scale <n>     pixels per voxel edge (default: 6)
  --no-render     validate only
  --strict        warnings count as failures
  --campaign      also validate and render the generated campaign (${CAMPAIGN_LENGTH} levels)
  --json          machine-readable report`;

function parseArgs(argv) {
  const opts = { out: 'thumbnails', scale: 6, render: true, strict: false, campaign: false, json: false, inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--out': opts.out = argv[++i]; break;
      case '--scale': opts.scale = Math.max(1, Math.min(32, Number(argv[++i]) || 6)); break;
      case '--no-render': opts.render = false; break;
      case '--strict': opts.strict = true; break;
      case '--campaign': opts.campaign = true; break;
      case '--json': opts.json = true; break;
      case '-h': case '--help': console.log(USAGE); process.exit(0); break;
      default:
        if (a.startsWith('-')) { console.error(`Unknown option ${a}\n${USAGE}`); process.exit(2); }
        opts.inputs.push(a);
    }
  }
  return opts;
}

/** Files and directories on the command line -> level JSON files (status / manifest files are skipped). */
function expandInputs(paths) {
  const files = [];
  for (const p of paths) {
    if (!existsSync(p)) { files.push({ path: p, missing: true }); continue; }
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) {
        if (extname(f) === '.json' && !f.endsWith('.status.json')) files.push({ path: join(p, f) });
      }
    } else {
      files.push({ path: p });
    }
  }
  return files;
}

const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'level';

function summarize(level) {
  if (!level) return '';
  const n = (arr, word) => `${arr.length} ${word}${arr.length === 1 ? '' : 's'}`;
  return `"${level.name}" ${level.size.join('×')} — ${n(level.guards, 'guard')}, ${n(level.enemySpawners, 'enemy pod')}, ` +
    `${n(level.signs, 'sign')}, ${n(level.crates, 'crate')}, ${level.spawn.count} troops, ${level.objective.required} required`;
}

function printReport(entry, opts) {
  const { label, result, failed, thumbnails } = entry;
  const mark = failed ? '✘' : result.warnings.length ? '⚠' : '✔';
  console.log(`${mark} ${label}  ${summarize(result.level)}`);
  for (const e of result.errors) console.log(`    ✖ ${e.path ? `${e.path}: ` : ''}${e.message}`);
  for (const w of result.warnings) console.log(`    ⚠ ${w.path ? `${w.path}: ` : ''}${w.message}`);
  if (!opts.json) for (const n of result.notes) console.log(`    · ${n.path ? `${n.path}: ` : ''}${n.message}`);
  for (const t of thumbnails) console.log(`    → ${t}`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.inputs.length && !opts.campaign) { console.error(USAGE); process.exit(2); }

  const jobs = [];
  for (const f of expandInputs(opts.inputs)) {
    if (f.missing) { jobs.push({ label: f.path, slug: slugify(basename(f.path)), raw: null, readError: 'file not found' }); continue; }
    try {
      jobs.push({ label: f.path, slug: slugify(basename(f.path, '.json')), raw: JSON.parse(readFileSync(f.path, 'utf8')) });
    } catch (err) {
      jobs.push({ label: f.path, slug: slugify(basename(f.path, '.json')), raw: null, readError: `not valid JSON: ${err.message}` });
    }
  }
  if (opts.campaign) {
    for (let i = 0; i < CAMPAIGN_LENGTH; i++) {
      const raw = buildCampaignLevel(i);
      jobs.push({ label: `campaign ${i + 1}/${CAMPAIGN_LENGTH}`, slug: `campaign-${String(i + 1).padStart(2, '0')}`, raw });
    }
  }

  const outDir = resolve(opts.out);
  if (opts.render) mkdirSync(outDir, { recursive: true });

  const entries = [];
  let anyFailed = false;
  for (const job of jobs) {
    const result = job.raw === null
      ? { ok: false, errors: [{ path: '', message: job.readError }], warnings: [], notes: [], level: null, world: null }
      : validateLevel(job.raw);
    const failed = !result.ok || (opts.strict && result.warnings.length > 0);
    anyFailed ||= failed;
    const thumbnails = [];
    if (opts.render && result.level && result.world) {
      try {
        const images = renderThumbnails(result.level, result.world, { scale: opts.scale });
        for (const [suffix, png] of Object.entries(images)) {
          const file = join(outDir, `${job.slug}.${suffix}`);
          writeFileSync(file, png);
          thumbnails.push(file);
        }
      } catch (err) {
        result.warnings.push({ path: 'render', message: `thumbnail failed: ${err.message}` });
      }
    }
    entries.push({ label: job.label, result, failed, thumbnails });
  }

  if (opts.json) {
    console.log(JSON.stringify(entries.map((e) => ({
      label: e.label, ok: !e.failed, errors: e.result.errors, warnings: e.result.warnings, notes: e.result.notes,
      name: e.result.level?.name ?? null, size: e.result.level?.size ?? null, thumbnails: e.thumbnails,
    })), null, 2));
  } else {
    for (const e of entries) printReport(e, opts);
    const failed = entries.filter((e) => e.failed).length;
    console.log(`\n${entries.length - failed}/${entries.length} levels OK${failed ? `, ${failed} failed` : ''}` +
      (opts.strict ? ' (strict)' : ''));
  }
  process.exit(anyFailed ? 1 : 0);
}

main();
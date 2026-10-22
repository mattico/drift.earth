// `node tools/handling.mjs --compare <ref> [same options]`: runs handling.mjs at
// another commit and in this working tree with the same options and diffs the
// results, number for number ("asphalt must not change" checked in one go).
// The commit is extracted to a temp dir (git archive) that borrows this
// checkout's packages, and removed afterwards.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Differences shown per scenario; the rest are counted. */
const SHOWN = 3;

/** → the process exit code: 0 identical, 1 different, 2 couldn't compare. */
export async function compare(root, ref, args, cars) {
  const json = args.includes('--json');
  // Each side gets one car at a time, as JSON; --check and --timeline only change the text.
  const pass = args.filter((a, i) => !['--json', '--check', '--timeline', '--car'].includes(a) && args[i - 1] !== '--car');
  let sha;
  try {
    sha = (await run('git', ['rev-parse', '--verify', '--short', `${ref}^{commit}`], root)).trim();
  } catch {
    console.error(`--compare: no commit "${ref}"`);
    return 2;
  }
  const dir = mkdtempSync(join(tmpdir(), 'drift-compare-'));
  const links = [];
  const out = { ref, commit: sha, args: pass, identical: true, cars: {} };
  try {
    await extract(root, sha, dir);
    if (!existsSync(join(dir, 'tools/handling.mjs'))) throw new Error(`${ref} has no tools/handling.mjs`);
    linkModules(join(root, 'node_modules'), join(dir, 'node_modules'), links);
    if (!json) console.log(`handling ${pass.join(' ') || '(every scenario)'}: ${ref} (${sha}) → working tree`);
    for (const car of cars) {
      const a = [...pass, '--car', car, '--json'];
      const [before, after] = (await Promise.all([run(process.execPath, [join(dir, 'tools/handling.mjs'), ...a], dir), run(process.execPath, [join(root, 'tools/handling.mjs'), ...a], root)])).map((s) =>
        JSON.parse(s),
      );
      const names = [...new Set([...Object.keys(before), ...Object.keys(after)])];
      const differ = {};
      for (const name of names) {
        const d = diff(before[name], after[name]);
        if (d.length) differ[name] = d;
      }
      out.cars[car] = { compared: names.length, differ };
      if (Object.keys(differ).length) out.identical = false;
      if (json) continue;
      const n = Object.keys(differ).length;
      console.log(`${car.padEnd(7)} ${String(names.length).padStart(3)} ${args.includes('--surfaces') ? 'surfaces' : 'scenarios'}  ${n ? `${n} differ` : 'identical'}`);
      for (const [name, d] of Object.entries(differ)) {
        const shown = d.slice(0, SHOWN).map((x) => `${x.path || '(all)'} ${show(x.before)} → ${show(x.after)}`);
        console.log(`  ${name}: ${shown.join('; ')}${d.length > SHOWN ? `; +${d.length - SHOWN} more` : ''}`);
      }
    }
  } catch (err) {
    console.error(`--compare failed: ${err.message}`);
    return 2;
  } finally {
    // The links first, so removing the dir can never reach into the real node_modules.
    for (const link of links) unlinkSync(link);
    rmSync(dir, { recursive: true, force: true });
  }
  if (json) console.log(JSON.stringify(out, null, 1));
  else console.log(out.identical ? 'identical' : 'DIFFERENT');
  return out.identical ? 0 : 1;
}

/**
 * Fills `to`, a new node_modules, with links to each of `from`'s packages (and
 * .pnpm, .bin) but not its .vite: both sides run at once, and a Vite rooted in
 * the temp dir would share this checkout's dep cache, find it stale (another
 * root, another hash) and delete it under a running dev server. Each link goes
 * into `links` as it's made, for the cleanup.
 */
function linkModules(from, to, links) {
  mkdirSync(to);
  for (const e of readdirSync(from, { withFileTypes: true })) {
    // Files (.modules.yaml and the like) aren't needed to resolve anything.
    if (e.name.startsWith('.vite') || !(e.isDirectory() || e.isSymbolicLink())) continue;
    // A junction needs no admin rights on Windows; elsewhere the type is ignored.
    symlinkSync(join(from, e.name), join(to, e.name), 'junction');
    links.push(join(to, e.name));
  }
}

/** Leaf-level differences: [{ path, before, after }], `undefined` where one side lacks it. */
function diff(a, b, path = '', out = []) {
  if (Object.is(a, b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], path ? `${path}.${k}` : k, out);
  } else {
    out.push({ path, before: a, after: b });
  }
  return out;
}

const show = (v) => (v === undefined ? 'missing' : typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v));

/** The commit's files, through tar (Windows' own bsdtar: Git Bash's GNU tar reads "C:" as a host). */
async function extract(root, sha, dir) {
  const winTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const tar = spawn(process.platform === 'win32' && existsSync(winTar) ? winTar : 'tar', ['-xf', '-', '-C', dir], { stdio: ['pipe', 'ignore', 'pipe'] });
  const git = spawn('git', ['archive', '--format=tar', sha], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  git.stdout.pipe(tar.stdin);
  const done = (p, name) =>
    new Promise((ok, fail) => {
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('error', fail);
      p.on('close', (code) => (code === 0 ? ok() : fail(new Error(`${name} exited ${code}: ${err.trim()}`))));
    });
  await Promise.all([done(git, 'git archive'), done(tar, 'tar')]);
}

/** Runs a command to completion → its stdout; throws with its stderr on failure. */
function run(cmd, args, cwd) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok(out) : fail(new Error(`${cmd === process.execPath ? 'node' : cmd} ${args.slice(0, 2).join(' ')} exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`))));
  });
}

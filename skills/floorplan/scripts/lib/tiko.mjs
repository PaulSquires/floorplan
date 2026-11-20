// tiko (https://github.com/PaulSquires/tiko-lang), a FreeBASIC-compatible language, and FreeBASIC itself.
// Files: .tiko sources and .ti headers, plus FreeBASIC's .bas / .bi / .inc.
//
// What links files:
//   #import "./textstats"        a module: a directory whose files start with #module "textstats"
//   #import "wordkit/textstats"  a module of the current package, or of a dependency in tiko.toml
//   #import "std/fs"             a module of the toolchain (std, vendor, sys): an outside package
//   #include once "util.ti"      textual inclusion, relative to the including file
//   #inclib "sqlite3"            a C library linked in
// Comments are ' and REM to the end of the line, and /' … '/ blocks (which nest).
// Kept apart from extract.mjs and resolve.mjs, which only call in here, so upstream merges stay clean.
import fs from 'node:fs';
import path from 'node:path';
import { cleanDoc } from './extract.mjs';

const P = path.posix;

const lineIndex = (src) => {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
};
const blank = (s) => s.replace(/[^\n]/g, ' ');
const isWord = (c) => c !== undefined && /[\w$]/.test(c);

/**
 * The source with its comments blanked out, offsets (and so line numbers) kept. Strings stay: the
 * import paths are in them. "" inside a string is a quote; !"…" strings also escape with a backslash.
 */
export function stripTiko(src) {
  let out = '', from = 0;
  const n = src.length;
  const cut = (a, b) => { out += src.slice(from, a) + blank(src.slice(a, b)); from = b; };
  let lineStart = true; // only whitespace (or a ':' statement break) since the line began: where REM may start
  for (let i = 0; i < n;) {
    const c = src[i];
    if (c === '\n') { lineStart = true; i++; continue; }
    if (c === '"') {
      const esc = src[i - 1] === '!';
      let j = i + 1;
      while (j < n && src[j] !== '\n') {
        if (esc && src[j] === '\\') { j += 2; continue; }
        if (src[j] === '"') { if (src[j + 1] === '"') { j += 2; continue; } break; }
        j++;
      }
      i = j + 1; lineStart = false; continue;
    }
    if (c === '/' && src[i + 1] === "'") {
      let depth = 1, j = i + 2;
      while (j < n && depth) {
        if (src[j] === '/' && src[j + 1] === "'") { depth++; j += 2; }
        else if (src[j] === "'" && src[j + 1] === '/') { depth--; j += 2; }
        else j++;
      }
      cut(i, j); i = j; continue;
    }
    if (c === "'" || (lineStart && (c === 'r' || c === 'R') && /^rem$/i.test(src.slice(i, i + 3)) && !isWord(src[i + 3]))) {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      cut(i, j); i = j; continue;
    }
    if (c === ':') lineStart = true;
    else if (c !== ' ' && c !== '\t' && c !== '\r') lineStart = false;
    i++;
  }
  return out + src.slice(from);
}

const KIND = { sub: 'function', function: 'function', type: 'type', union: 'type', class: 'class', interface: 'interface', enum: 'enum' };
const IGNORED_HOST = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|(www\.)?example\.(com|org|net)$|(www\.)?w3\.org$|schemas\.)/i;

/** A comment-only line's text, or null. */
function commentText(line) {
  const m = /^\s*(?:'+|rem\b)\s?(.*)$/i.exec(line);
  return m ? m[1] : null;
}

/** The comment run (or /' '/ block) ending on the line above `idx` (0-based), as text. */
function commentAbove(lines, idx) {
  let i = idx - 1;
  if (i >= 0 && /'\/\s*$/.test(lines[i])) {
    const end = i;
    while (i >= 0 && i > end - 60 && !/\/'/.test(lines[i])) i--;
    return i >= 0 && /\/'/.test(lines[i]) ? lines.slice(i, end + 1).join('\n').replace(/\/'+|'+\//g, '') : null;
  }
  const buf = [];
  for (let t; i >= 0 && buf.length < 60 && (t = commentText(lines[i])) !== null; i--) buf.unshift(t);
  return buf.length ? buf.join('\n') : null;
}

/** The file's leading comment, past blank lines and #pragma / #module / #lang / #cmdline lines. */
function headerText(lines) {
  let i = 0;
  const skip = (l) => !l.trim() || /^\s*#\s*(pragma|module|lang|cmdline)\b/i.test(l);
  while (i < lines.length && skip(lines[i])) i++;
  if (/^\s*\/'/.test(lines[i] || '')) {
    const start = i;
    while (i < lines.length && i < start + 60 && !/'\//.test(lines[i])) i++;
    return lines.slice(start, i + 1).join('\n').replace(/\/'+|'+\//g, '');
  }
  const buf = [];
  for (let t; i < lines.length && buf.length < 60 && (t = commentText(lines[i])) !== null; i++) buf.push(t);
  return buf.join('\n');
}

/** cleanDoc, after dropping the "name.tiko -- " or "name -- " that many tiko headers start with. */
const tikoDoc = (text) => cleanDoc((text || '').replace(/^\s*(?:[\w.-]+\.(?:tiko|ti|bas|bi|inc)\s*(?:--|—|-|:)|[\w.-]+\s+(?:--|—))\s*/i, ''));

/** A header's first paragraph that says something: a copyright or licence paragraph above it is passed over. */
const headerDoc = (text) => {
  for (const para of (text || '').split(/\n\s*\n/).slice(0, 4)) { const d = tikoDoc(para); if (d) return d; }
  return null;
};

export function extractTiko(src) {
  const code = stripTiko(src);
  const at = lineIndex(code);
  const imports = [];
  const all = (re) => [...code.matchAll(re)];

  for (const m of all(/^[ \t]*#[ \t]*import[ \t]+"([^"\n]+)"([^\n]*)/gim)) {
    const rest = m[2];
    const alias = /\bas[ \t]+([A-Za-z_]\w*)/i.exec(rest)?.[1];
    imports.push({ spec: m[1], names: [], kind: 'module', line: at(m.index),
      ...(/\bpublic\b/i.test(rest) ? { reexport: true } : {}), ...(alias ? { alias } : {}) });
  }
  for (const m of all(/^[ \t]*#[ \t]*include[ \t]+(?:once[ \t]+)?"([^"\n]+)"/gim)) {
    imports.push({ spec: m[1].replace(/\\/g, '/'), names: [], kind: 'include', line: at(m.index) });
  }
  for (const m of all(/^[ \t]*#[ \t]*inclib[ \t]+"([^"\n]+)"/gim)) {
    imports.push({ spec: m[1], names: [], kind: 'lib', line: at(m.index) });
  }
  const moduleName = /^[ \t]*#[ \t]*module[ \t]+"([^"\n]+)"/im.exec(code)?.[1];

  // Top-level procedures and types. In a module only `public` names reach importers, so only those are
  // listed; elsewhere every name not marked private is visible to whoever includes the file.
  // Methods (sub Type.Name), declarations and anything inside a type's body are left out.
  const symbols = [];
  const lines = code.split('\n');
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*end[ \t]+(type|union|class|interface|enum)\b/i.test(l)) { depth = Math.max(0, depth - 1); continue; }
    const m = /^\s*(?:(public|private|protected)\s+)?(?:(?:static|virtual|abstract|override|export|overload)\s+)*(sub|function|type|union|class|interface|enum)\b(?:\s+([A-Za-z_]\w*)(\.\w+)?)?\s*(.*)$/i.exec(l);
    if (!m) continue;
    const [, vis, kw, name, member, rest] = m;
    const kind = KIND[kw.toLowerCase()];
    const block = kind !== 'function' && !/^as\b/i.test(rest) && !/^=/.test(rest); // `type Name as Other` is an alias
    if (depth === 0 && name && !member && (moduleName ? /^public$/i.test(vis || '') : !/^private$/i.test(vis || ''))) {
      symbols.push({ name, kind, line: i + 1 });
    }
    if (block) depth++;
  }

  // Web addresses the code uses: the outside hosts it calls
  const hosts = [];
  for (const m of all(/"(?:https?|wss?):\/\/([^\/"\s:?#]+)/gi)) {
    if (!IGNORED_HOST.test(m[1])) hosts.push({ host: m[1].toLowerCase(), line: at(m.index) });
  }

  const srcLines = src.split('\n');
  for (const s of symbols) {
    const d = tikoDoc(commentAbove(srcLines, s.line - 1));
    if (d) s.doc = d;
  }
  return {
    imports, symbols, routes: [], mounts: [], calls: [], hosts,
    ...(moduleName ? { module: moduleName } : {}),
    doc: headerDoc(headerText(srcLines)),
  };
}

// ---------- resolving ----------

// The toolchain's own headers (tiko's inc/, fbc's inc/): a missing #include of one of these is the
// compiler's, not a broken link.
const TOOLCHAIN_INC = new Set(['gl', 'x11', 'crt', 'win', 'fbc-int', 'sys', 'afx', 'crt.bi', 'datetime.bi', 'dir.bi',
  'fbatomic.bi', 'fbclaim.bi', 'fberror.bi', 'fbgfx.bi', 'fbio.bi', 'fblimits.bi', 'fbpark.bi', 'fbprng.bi',
  'fbthread.bi', 'ffi.bi', 'file.bi', 'fmod.bi', 'glib-object.bi', 'glib.bi', 'glibconfig.bi', 'gmodule.bi',
  'libiconv.bi', 'libintl.bi', 'lzma.bi', 'string.bi', 'utf_conv.bi', 'uuid.bi', 'vbcompat.bi', 'windows.bi',
  'zip.bi', 'zlib.bi', 'fbcunit.bi', 'sdl', 'sdl2', 'curl.bi', 'sqlite3.bi', 'cairo', 'gtk', 'allegro.bi']);
const TOOLCHAIN_PKG = new Set(['std', 'vendor', 'sys']);
const SOURCE = /\.(tiko|bas)$/i;

/** [package] name and [dependencies] paths of a tiko.toml, read loosely. */
function readManifest(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const out = { name: null, deps: new Map() };
  let section = '';
  for (const raw of txt.split('\n')) {
    const l = raw.replace(/#.*$/, '').trim();
    const sec = /^\[([^\]]+)\]$/.exec(l);
    if (sec) { section = sec[1].trim(); continue; }
    if (section === 'package') { const m = /^name\s*=\s*"([^"]+)"/.exec(l); if (m) out.name = m[1]; }
    if (section === 'dependencies') { const m = /^([\w-]+)\s*=\s*\{[^}]*\bpath\s*=\s*"([^"]+)"/.exec(l); if (m) out.deps.set(m[1], m[2].replace(/\\/g, '/')); }
  }
  return out;
}

/**
 * The resolver for tiko files. `resolveRelative` is resolve.mjs's own (relative path, then a basename
 * found once in the whole codebase).
 */
export function createTikoResolver(root, files, resolveRelative) {
  const tikoFiles = files.filter((f) => f.lang === 'tiko');
  const byLower = new Map();
  for (const f of files) { const k = f.path.toLowerCase(); byLower.set(k, byLower.has(k) ? null : f.path); }
  // a module's files: the sources directly in its directory, the ones saying #module first
  const inDir = new Map();
  for (const f of tikoFiles) {
    if (!SOURCE.test(f.path)) continue;
    const d = P.dirname(f.path).toLowerCase();
    if (!inDir.has(d)) inDir.set(d, []);
    inDir.get(d).push(f);
  }
  const moduleFiles = (dir) => {
    const list = inDir.get(P.normalize(dir).toLowerCase()) || [];
    const mods = list.filter((f) => f.module);
    return (mods.length ? mods : list).map((f) => f.path);
  };
  // packages: every directory with a tiko.toml
  const manifests = new Map();
  for (const f of files) if (P.basename(f.path).toLowerCase() === 'tiko.toml') {
    const m = readManifest(path.join(root, f.path));
    if (m) manifests.set(P.dirname(f.path), m);
  }
  const packageOf = (file) => {
    for (let d = P.dirname(file); ; d = P.dirname(d)) {
      if (manifests.has(d)) return { dir: d, ...manifests.get(d) };
      if (d === '.' || d === '' || d === '/') return null;
    }
  };
  const repoRoot = (file) => file.repo && file.repo !== '.' ? file.repo : '';
  const found = (list) => (list.length === 1 ? { file: list[0] } : list.length ? { files: list } : null);

  const resolveImport = (file, spec) => {
    const s = spec.replace(/\\/g, '/');
    const first = s.split('/')[0];
    if (s.startsWith('./') || s.startsWith('../')) return found(moduleFiles(P.join(P.dirname(file.path), s))) || { unresolved: true };
    if (TOOLCHAIN_PKG.has(first)) return { external: s, eco: 'tiko' };
    const pkg = packageOf(file.path);
    const rest = s.split('/').slice(1).join('/');
    if (pkg?.name === first) return found(moduleFiles(P.join(pkg.dir, rest))) || { unresolved: true };
    if (pkg?.deps.has(first)) {
      const hit = found(moduleFiles(P.join(pkg.dir, pkg.deps.get(first), rest)));
      return hit || { external: first, eco: 'tiko' }; // a dependency outside the mapped folder
    }
    // an -i / TIKO_PATH directory: try the repo's root and the mapped folder's
    return found(moduleFiles(P.join(repoRoot(file), s))) || found(moduleFiles(s)) || { external: first, eco: 'tiko' };
  };

  const resolveInclude = (file, spec) => {
    const r = resolveRelative(file.path, spec, []);
    if (r.file) return r;
    // Windows file names: case doesn't matter
    const rel = byLower.get(P.normalize(P.join(P.dirname(file.path), spec)).toLowerCase());
    if (rel) return { file: rel };
    // an -i directory: the repo's root, or the mapped folder's
    for (const base of [repoRoot(file), '']) {
      const hit = byLower.get(P.normalize(P.join(base, spec)).toLowerCase());
      if (hit) return { file: hit };
    }
    const first = spec.split('/')[0].toLowerCase();
    if (TOOLCHAIN_INC.has(first) || TOOLCHAIN_INC.has(P.basename(spec).toLowerCase()) && !spec.includes('/')) return { builtin: true };
    // "AfxNova/AfxWin.inc", found through an -i directory outside the mapped folder: a library of its own
    if (spec.includes('/') && !spec.startsWith('.')) return { external: spec.split('/')[0], eco: 'tiko' };
    return { unresolved: true };
  };

  return (file, imp) => {
    if (imp.kind === 'lib') return { external: imp.spec, eco: 'lib' };
    if (imp.kind === 'module') return resolveImport(file, imp.spec);
    return resolveInclude(file, imp.spec);
  };
}

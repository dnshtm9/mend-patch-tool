// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as [old, new], in patch order. */
  moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Files and line matching (SPEC.md sections 3 and 5) ----

type Piece = { op: ' ' | '-' | '+'; text: string };
type Body = { op: ' ' | '-' | '+' | '\\'; text: string };
type Hunk = { a: number; body: Body[] };
type FileState = { lines: string[]; br: string; final: boolean };

const tiersFor = (strict: boolean): number => (strict ? 1 : 3);

/** A line as compared at a tier: 0 exact, 1 trailing blanks dropped, 2 both sides trimmed. */
function norm(tier: number, s: string): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+|[ \t]+$/g, '');
}

/** Every position where the lines O match the file's lines at one tier; occurrences may overlap. */
function occurrences(L: string[], O: string[], tier: number): number[] {
  const o = O.map((s) => norm(tier, s));
  const l = L.map((s) => norm(tier, s));
  const at: number[] = [];
  for (let i = 0; i + o.length <= l.length; i += 1) {
    let ok = true;
    for (let k = 0; ok && k < o.length; k += 1) ok = l[i + k] === o[k];
    if (ok) at.push(i);
  }
  return at;
}

/** The first tier at which O occurs at all, with its occurrences. */
function findTier(L: string[], O: string[], strict: boolean): { tier: number; at: number[] } | null {
  for (let tier = 0; tier < tiersFor(strict); tier += 1) {
    const at = occurrences(L, O, tier);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

const leadingWs = (s: string): string => s.match(/^[ \t]*/)![0];

/**
 * The lines that replace a matched block. A context piece is written as the file's own matched line; at tier 2 an
 * added piece starting with the old block's indent P has P replaced by the file's indent F.
 */
function rebuild(matched: string[], pieces: Piece[], tier: number): string[] {
  const first = pieces.find((p) => p.op !== '+');
  const F = tier === 2 && matched.length > 0 ? leadingWs(matched[0]!) : '';
  const P = tier === 2 && first !== undefined ? leadingWs(first.text) : '';
  const out: string[] = [];
  let k = 0;
  for (const p of pieces) {
    if (p.op === '-') {
      k += 1;
    } else if (p.op === ' ') {
      out.push(matched[k]!);
      k += 1;
    } else {
      out.push(tier === 2 && !blank(p.text) && p.text.startsWith(P) ? F + p.text.slice(P.length) : p.text);
    }
  }
  return out;
}

/** The occurrence nearest the target; of two equally near, the earlier (`at` is ascending). */
function nearest(at: number[], target: number): number {
  let best = at[0]!;
  for (const p of at) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  return best;
}

/** A file's text as lines, its line break (CRLF when its first LF follows a CR) and whether it ends with a break. */
function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function serialize(f: FileState): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

function need(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function searchEdit(path: string, oldL: string[], newL: string[], strict: boolean): Edit {
  return (tree) => {
    need(path);
    const cur = tree.get(path);
    if (oldL.length === 0) {
      if (cur !== null) throw new Fail('exists', path);
      tree.now.set(path, newL.map((t) => `${t}\n`).join(''));
      return;
    }
    if (cur === null) throw new Fail('missing', path);
    const f = parseFile(cur);
    const found = findTier(f.lines, oldL, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const pos = found.at[0]!;
    const pieces: Piece[] = [...oldL.map((t): Piece => ({ op: '-', text: t })), ...newL.map((t): Piece => ({ op: '+', text: t }))];
    f.lines.splice(pos, oldL.length, ...rebuild(f.lines.slice(pos, pos + oldL.length), pieces, found.tier));
    tree.now.set(path, serialize(f));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let lower = 0;
  for (;;) {
    let s = -1;
    for (let k = lower; k < lines.length && s < 0; k += 1) if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') s = k;
    if (s < 0) break;
    let path: string | null = null;
    for (let k = s - 1; k >= lower && path === null; k -= 1) {
      const t = lines[k]!.trim();
      if (t !== '' && !t.startsWith('```')) path = t;
    }
    path ??= prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    for (let k = s + 1; k < lines.length && eq < 0; k += 1) if (lines[k]!.trimEnd() === '=======') eq = k;
    let rep = -1;
    for (let k = eq + 1; eq >= 0 && k < lines.length && rep < 0; k += 1) if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') rep = k;
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(searchEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    lower = rep + 1;
  }
  return edits;
}

// ---- Unified diffs (SPEC.md section 6) ----

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

/** The path of a `--- ` or `+++ ` line: `/dev/null` is null, a leading `a/` or `b/` is dropped. */
function namePath(line: string): string | null {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.replace(/^ +| +$/g, '');
  if (s === '/dev/null') return null;
  return s.replace(/^[ab]\//, '');
}

interface Section {
  oldP?: string | null;
  newP?: string | null;
  gitX?: string;
  gitY?: string;
  renameFrom?: string;
  renameTo?: string;
  isNew: boolean;
  isDel: boolean;
  inHeader: boolean;
  hunks: Hunk[];
}

function headerLine(s: Section, l: string): void {
  if (l.startsWith('rename from ')) s.renameFrom = l.slice('rename from '.length).trim();
  else if (l.startsWith('rename to ')) s.renameTo = l.slice('rename to '.length).trim();
  else if (l.startsWith('new file mode')) s.isNew = true;
  else if (l.startsWith('deleted file mode')) s.isDel = true;
}

/** Whether line j belongs to a hunk body. */
function bodyLine(lines: string[], j: number): boolean {
  const b = lines[j]!;
  if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) return false;
  return b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\';
}

function toBody(b: string): Body {
  return b === '' ? { op: ' ', text: '' } : { op: b[0] as Body['op'], text: b.slice(1) };
}

/** Whether the last context or `+` line of a body is followed by a `\` line. */
function breakMarked(body: Body[]): boolean {
  let j = body.length - 1;
  while (j >= 0 && body[j]!.op !== ' ' && body[j]!.op !== '+') j -= 1;
  return j >= 0 && body[j + 1]?.op === '\\';
}

/** A created file: the `+` lines of all its hunks, ended by a break unless a `\` line follows the last one. */
function creationText(hunks: Hunk[]): string {
  const texts: string[] = [];
  let noBreak = false;
  for (const h of hunks) {
    h.body.forEach((b, j) => {
      if (b.op === '+') {
        texts.push(b.text);
        noBreak = h.body[j + 1]?.op === '\\';
      }
    });
  }
  if (texts.length === 0) return '';
  return texts.join('\n') + (noBreak ? '' : '\n');
}

/** Applies a section's hunks in order to a file; throws Fail when a hunk finds no place. */
function applyHunks(f: FileState, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const pieces = h.body.filter((b): b is Piece => b.op !== '\\');
    const O = pieces.filter((p) => p.op !== '+').map((p) => p.text);
    let pos: number;
    let tier = 0;
    if (O.length > 0) {
      const found = findTier(f.lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      pos = nearest(found.at, h.a - 1 + d);
      tier = found.tier;
    } else {
      pos = Math.min(Math.max(h.a + d, 0), f.lines.length);
    }
    const runsToEnd = pos + O.length === f.lines.length;
    const out = rebuild(f.lines.slice(pos, pos + O.length), pieces, tier);
    f.lines.splice(pos, O.length, ...out);
    d += out.length - O.length;
    if (runsToEnd) f.final = !breakMarked(h.body);
  }
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  const oldName = s.oldP !== undefined ? s.oldP : (s.renameFrom ?? s.gitX ?? null);
  const newName = s.newP !== undefined ? s.newP : (s.renameTo ?? s.gitY ?? null);
  if (oldName === null || s.isNew) {
    const p = newName ?? '';
    return (tree) => {
      need(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, creationText(s.hunks));
    };
  }
  if (newName === null || s.isDel) {
    return (tree) => {
      need(oldName);
      if (tree.get(oldName) === null) throw new Fail('missing', oldName);
      tree.now.set(oldName, null);
    };
  }
  const move = oldName !== newName;
  return (tree) => {
    need(oldName);
    if (move) need(newName);
    const cur = tree.get(oldName);
    if (cur === null) throw new Fail('missing', oldName);
    if (move && tree.get(newName) !== null) throw new Fail('exists', newName);
    const f = parseFile(cur);
    applyHunks(f, s.hunks, strict, oldName);
    const text = serialize(f);
    if (move) {
      tree.now.set(oldName, null);
      tree.now.set(newName, text);
      tree.moves.push([oldName, newName]);
    } else {
      tree.now.set(oldName, text);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const secs: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    const next = lines[i + 1] ?? '';
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { gitX: m[1], gitY: m[2], isNew: false, isDel: false, inHeader: true, hunks: [] };
      secs.push(cur);
      i += 1;
    } else if (l.startsWith('@@')) {
      const m = HUNK_HEADER.exec(l);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.inHeader = false;
      let j = i + 1;
      while (j < lines.length && bodyLine(lines, j)) j += 1;
      let end = j;
      while (end > i + 1 && lines[end - 1] === '') end -= 1;
      cur.hunks.push({ a: Number(m[1]), body: lines.slice(i + 1, end).map(toBody) });
      i = j;
    } else if (cur !== null && cur.inHeader && l.startsWith('--- ')) {
      if (!next.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      cur.oldP = namePath(l);
      cur.newP = namePath(next);
      i += 2;
    } else if (l.startsWith('--- ') && next.startsWith('+++ ')) {
      cur = { oldP: namePath(l), newP: namePath(next), isNew: false, isDel: false, inHeader: true, hunks: [] };
      secs.push(cur);
      i += 2;
    } else {
      if (cur !== null && cur.inHeader) headerLine(cur, l);
      i += 1;
    }
  }
  return secs.map((s) => unifiedEdit(s, strict));
}

// ---- V4A patches (SPEC.md section 8) ----

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: Piece[];
}

const V4A_HEADERS = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];
const isV4aHeader = (l: string): boolean => V4A_HEADERS.some((h) => l.startsWith(h));
/** The rest of a V4A header line after its colon, surrounding spaces removed. */
const afterColon = (l: string): string => l.slice(l.indexOf(': ') + 2).trim();

function v4aAdd(path: string, texts: string[]): Edit {
  return (tree) => {
    need(path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, texts.map((t) => `${t}\n`).join(''));
  };
}

function v4aDelete(path: string): Edit {
  return (tree) => {
    need(path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function applyChunks(f: FileState, chunks: Chunk[], strict: boolean, path: string): void {
  const L = f.lines;
  const tiers = tiersFor(strict);
  let cursor = 0;
  for (const c of chunks) {
    if (c.anchor !== null) {
      let found = -1;
      for (let tier = 0; tier < tiers && found < 0; tier += 1) {
        const want = norm(tier, c.anchor);
        for (let j = cursor; j < L.length; j += 1) {
          if (norm(tier, L[j]!) === want) {
            found = j;
            break;
          }
        }
      }
      if (found < 0) throw new Fail('no-match', path);
      cursor = found + 1;
    }
    const O = c.body.filter((p) => p.op !== '+').map((p) => p.text);
    if (O.length === 0) {
      const at = c.eof ? L.length : cursor;
      const add = c.body.map((p) => p.text);
      L.splice(at, 0, ...add);
      cursor = at + add.length;
      continue;
    }
    let hit: { tier: number; p: number } | null = null;
    for (let tier = 0; tier < tiers && hit === null; tier += 1) {
      const ps = occurrences(L, O, tier).filter((p) => p >= cursor && (!c.eof || p + O.length === L.length));
      if (ps.length > 0) hit = { tier, p: ps[0]! };
    }
    if (hit === null) throw new Fail('no-match', path);
    const out = rebuild(L.slice(hit.p, hit.p + O.length), c.body, hit.tier);
    L.splice(hit.p, O.length, ...out);
    cursor = hit.p + out.length;
  }
}

function v4aUpdate(path: string, move: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    need(path);
    if (move !== null) need(move);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (move !== null && tree.get(move) !== null) throw new Fail('exists', move);
    const f = parseFile(cur);
    applyChunks(f, chunks, strict, path);
    const text = serialize(f);
    if (move !== null) {
      tree.now.set(path, null);
      tree.now.set(move, text);
      tree.moves.push([path, move]);
    } else {
      tree.now.set(path, text);
    }
  };
}

/** The lines from `from` to `end` of an Update File section: an optional Move to, then its chunks. */
function parseUpdate(lines: string[], headerIdx: number, from: number, end: number): { move: string | null; chunks: Chunk[] } {
  let k = from;
  let move: string | null = null;
  if (k < end && lines[k]!.startsWith('*** Move to: ')) {
    move = afterColon(lines[k]!);
    k += 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  let closed = false;
  for (; k < end; k += 1) {
    const l = lines[k]!;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).replace(/^ +| +$/g, '');
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      chunks.push(cur);
      closed = false;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null || closed) throw new Exit2(`error: parse ${k + 1}`);
      cur.eof = true;
      closed = true;
      continue;
    }
    if (closed) {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${k + 1}`);
    }
    if (l !== '' && l[0] !== ' ' && l[0] !== '-' && l[0] !== '+') throw new Exit2(`error: parse ${k + 1}`);
    if (cur === null) {
      cur = { anchor: null, eof: false, body: [] };
      chunks.push(cur);
    }
    cur.body.push(l === '' ? { op: ' ', text: '' } : { op: l[0] as Piece['op'], text: l.slice(1) });
  }
  if (move === null && chunks.length === 0) throw new Exit2(`error: parse ${headerIdx + 1}`);
  return { move, chunks };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (!isV4aHeader(l)) throw new Exit2(`error: parse ${i + 1}`);
    let stop = i + 1;
    while (stop < last && !isV4aHeader(lines[stop]!)) stop += 1;
    let end = stop;
    while (end > i + 1 && blank(lines[end - 1]!)) end -= 1;
    const path = afterColon(l);
    if (l.startsWith('*** Add File: ')) {
      const texts: string[] = [];
      for (let k = i + 1; k < end; k += 1) {
        const b = lines[k]!;
        if (b.startsWith('+')) texts.push(b.slice(1));
        else if (b === '') texts.push('');
        else throw new Exit2(`error: parse ${k + 1}`);
      }
      edits.push(v4aAdd(path, texts));
    } else if (l.startsWith('*** Delete File: ')) {
      for (let k = i + 1; k < end; k += 1) if (!blank(lines[k]!)) throw new Exit2(`error: parse ${k + 1}`);
      edits.push(v4aDelete(path));
    } else {
      const { move, chunks } = parseUpdate(lines, i, i + 1, end);
      edits.push(v4aUpdate(path, move, chunks, strict));
    }
    i = stop;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'search-replace'
          ? searchReplaceEdits(lines, strict)
          : kind === 'unified'
            ? unifiedEdits(lines, strict)
            : kind === 'v4a'
              ? v4aEdits(lines, strict)
              : [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  // A move whose old path is gone and new path is there, both as the patch found them, is one R line.
  const renamed = new Map<string, string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) != null) renamed.set(n, o);
  }
  const rows: { key: string; line: string }[] = [];
  for (const [n, o] of renamed) rows.push({ key: n, line: `R ${o} -> ${n}` });
  for (const p of [...tree.now.keys()].sort(byBytes)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (renamed.has(p) || [...renamed.values()].includes(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byBytes(a.key, b.key));
  if (!check) {
    for (const p of tree.now.keys()) {
      const now = tree.now.get(p)!;
      if (now === tree.original(p)) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

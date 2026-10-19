#!/usr/bin/env node
// Issue #28 (ADR 0018, 0019) and issue #66 (ADR 0020): compares the ADRs of HEAD with a base reference and
// fails when a frozen record changed, a status moved the wrong way, the date of a decided record changed
// without a status transition, a record was deleted or renamed, the numbering broke or the index misses a
// record. The status is read only from the MADR 4 front matter `status` field; the one-time mechanical
// migration of a legacy record into front matter passes whatever its base status. Usage, from inside the
// repository: node scripts/check-adrs.mjs <base-ref>
// Exit 0 when clean; otherwise non-zero, with one line per problem on stderr, starting with the file
// (file:line when a line is known). Both refs are committed trees, compared directly, not through a merge
// base. A local run against a branch behind main should pass the merge base as <base-ref>.
// The repo-bootstrap templates carry a copy of this file: change it here, then install.
import { spawnSync } from 'node:child_process';
import { posix } from 'node:path';

const directories = ['docs/adr', 'docs/adrs', 'docs/decisions'];
const recordName = /^\d{4}-[^/]+\.md$/;
const known = new Set(['proposed', 'accepted', 'rejected', 'superseded', 'deprecated']);
// The statuses a decided base record may move to. A missing or unrecognised base status may only be
// normalised to a decision: never to proposed, which would unfreeze it, nor to deprecated, which only an
// accepted record may become.
const transitions = {
  accepted: ['accepted', 'superseded', 'deprecated'],
  rejected: ['rejected', 'superseded'],
  superseded: ['superseded'],
  deprecated: ['deprecated', 'superseded'],
  unknown: ['accepted', 'rejected', 'superseded'],
};
const legacyStatus = /^(?:- Status:|Status:)/;
const legacyDate = /^- Date:/;
const field = /^([A-Za-z][\w-]*):(?:[ \t]+(.*))?$/;
// Only ASCII blanks are trimmed: records are read as latin1 (see blob), where a UTF-8 byte may read as a
// no-break space.
const trim = (text) => text.replace(/^[ \t]+|[ \t]+$/g, '');
// A status or date read as latin1, shown as the UTF-8 it was written in.
const shown = (text) => Buffer.from(text, 'latin1').toString('utf8');

function problem(file, message) {
  console.error(`${file}: ${message}`);
  process.exitCode = 1;
}

function git(file, ...args) {
  return gitAs('utf8', file, ...args);
}

function gitAs(encoding, file, ...args) {
  const result = spawnSync('git', args, { encoding, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${file}: cannot read git data (${result.error?.message ?? result.stderr.trim().replace(/\s*\n\s*/g, '; ')})`);
  }
  return result.stdout;
}

// A record, byte for byte: latin1 maps each byte to one character, so an edit to bytes that are not valid
// UTF-8 still shows as a change, where UTF-8 decoding would turn both versions into the same U+FFFD. Every
// marker the check reads is ASCII; only the status word is read from the UTF-8 the value was written in, so
// that a no-break space after it still ends it.
const blob = (ref, file) => gitAs('latin1', file, 'show', `${ref}:${file}`);

function tree(ref) {
  return git(ref, 'rev-parse', '--verify', '--end-of-options', `${ref}^{tree}`).trim();
}

function paths(ref, ...pathspecs) {
  return new Set(git(ref, 'ls-tree', '-r', '-z', '--name-only', ref, '--', ...pathspecs).split('\0').filter(Boolean));
}

// A YAML scalar as written by hand or by scripts/migrate-adrs.mjs: double quotes unescape \" and \\, single
// quotes turn '' into '.
function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

// The front matter of a record: line 1 is exactly "---" and it closes at the next "---" line. null when
// there is none, so the record has no status. Lines that are not "key: value" are kept as they are.
function frontMatter(lines) {
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  const fields = [];
  for (let index = 1; index < end; index++) {
    const match = field.exec(lines[index]);
    if (match) fields.push({ key: match[1], value: unquote(trim(match[2] ?? '')), index });
  }
  return { end, fields };
}

function record(text) {
  const lines = text.split('\n');
  const front = frontMatter(lines);
  const statuses = front?.fields.filter((entry) => entry.key === 'status') ?? [];
  const dates = front?.fields.filter((entry) => entry.key === 'date') ?? [];
  // Two status fields, or one that is empty or only blanks, are as good as none: the record counts as
  // missing a status. Legacy lines never count.
  const status = statuses.length === 1 && /[^ \t]/.test(statuses[0].value) ? statuses[0].value : null;
  // A word glued to more text, such as proposed-x, is no status word: it reads as unrecognised, so frozen.
  const word = status === null ? undefined : /^([a-z]+)(?=$|[\s,;:.([])/i.exec(shown(status))?.[1].toLowerCase();
  const metadata = new Set([...statuses, ...dates].map((entry) => entry.index));
  const numbered = lines.map((text, index) => ({ text, line: index + 1 }));
  let body = numbered.filter((_, index) => !metadata.has(index));
  // Front matter that holds only the status and the date adds nothing but them: adding it to a record that
  // had none is adding the status, a normalisation, not a body change.
  if (front && front.end - 1 === metadata.size) body = numbered.slice(front.end + 1);
  return {
    status: status ?? '(missing)',
    statusLine: status === null ? null : statuses[0].index + 1,
    word: known.has(word) ? word : null,
    date: dates.length ? dates.map((entry) => entry.value).join('\n') : null,
    dateLine: dates.length ? dates[0].index + 1 : null,
    body,
  };
}

// ADR 0020: the one-time migration of a legacy record. The base has no front matter, one legacy status line
// and at most one "- Date:" line; the head adds front matter holding exactly that status and that date and
// removes those lines, every other line identical. Anything else goes through the frozen rules.
function mechanicalMigration(before, after) {
  const base = before.split('\n');
  if (base[0] === '---') return false;
  const statusAt = base.flatMap((line, index) => (legacyStatus.test(line) ? [index] : []));
  const dateAt = base.flatMap((line, index) => (legacyDate.test(line) ? [index] : []));
  if (statusAt.length !== 1 || dateAt.length > 1) return false;
  const expected = { status: trim(base[statusAt[0]].replace(legacyStatus, '')) };
  if (expected.status === '') return false;
  if (dateAt.length) expected.date = trim(base[dateAt[0]].slice('- Date:'.length));
  const head = after.split('\n');
  if (head[0] !== '---') return false;
  const end = head.indexOf('---', 1);
  if (end < 0) return false;
  const seen = {};
  for (const line of head.slice(1, end)) {
    const match = field.exec(line);
    if (!match || !(match[1] in expected) || match[1] in seen) return false;
    seen[match[1]] = unquote(trim(match[2] ?? ''));
  }
  if (Object.keys(seen).length !== Object.keys(expected).length) return false;
  if (Object.entries(expected).some(([key, value]) => seen[key] !== value)) return false;
  const rest = head.slice(end + 1);
  const kept = base.filter((_, index) => index !== statusAt[0] && index !== dateAt[0]);
  return rest.length === kept.length && rest.every((line, index) => line === kept[index]);
}

function checkRecord(file, before, after) {
  if (before === after || mechanicalMigration(before, after)) return;
  const base = record(before);
  const head = record(after);
  const where = (line) => (line ? `${file}:${line}` : file);
  // A proposed record is a draft: its body and date are free, but deprecated is reachable only from accepted.
  if (base.word === 'proposed') {
    if (head.word === 'deprecated') problem(where(head.statusLine), `invalid status transition from "${shown(base.status)}" to "${shown(head.status)}"`);
    return;
  }
  const changed = head.body.findIndex((line, index) => line.text !== base.body[index]?.text);
  if (changed !== -1 || head.body.length !== base.body.length) {
    const line = head.body[changed]?.line ?? head.body.at(-1)?.line ?? 1;
    problem(`${file}:${line}`, 'record is frozen on the base; only its front matter status may change');
  }
  const allowed = transitions[base.word ?? 'unknown'].includes(head.word);
  if (!allowed) problem(where(head.statusLine), `invalid status transition from "${shown(base.status)}" to "${shown(head.status)}"`);
  if (head.date !== base.date && !(allowed && head.word !== base.word)) {
    problem(where(head.dateLine), `the date of a decided record changes only with a status transition (from "${shown(base.date ?? '(missing)')}" to "${shown(head.date ?? '(missing)')}")`);
  }
}

const pad = (number) => String(number).padStart(4, '0');

function checkNumbers(directory, baseRecords, headRecords) {
  const next = Math.max(0, ...baseRecords.map((file) => Number(file.slice(0, 4)))) + 1;
  const added = new Set();
  let expected = next;
  for (const file of headRecords.filter((file) => !baseRecords.includes(file)).sort()) {
    const number = Number(file.slice(0, 4));
    if (number < next) {
      problem(`${directory}/${file}`, `record number ${pad(number)} is already used on the base`);
    } else if (added.has(number)) {
      problem(`${directory}/${file}`, `record number ${pad(number)} is added twice`);
    } else {
      if (number !== expected) problem(`${directory}/${file}`, `record number ${pad(number)} must continue the base numbering at ${pad(expected)}`);
      added.add(number);
      expected = number + 1;
    }
  }
  // Name every number the added records skip, not only the first record out of sequence.
  for (let number = next; number < Math.max(next, ...added); number++) {
    if (!added.has(number)) problem(directory, `record number ${pad(number)} is missing from the added records`);
  }
}

// The index format is free: only inline links whose file name is a record's count. Other documents,
// external pages (with a scheme or protocol-relative), anchors and repeated links are ignored. A link may
// carry a title or wrap its destination in angle brackets; one that starts with / resolves from the
// repository root, as GitHub resolves it.
function checkIndex(directory, records, text, exists) {
  const indexed = new Set();
  for (const [index, line] of text.split('\n').entries()) {
    for (const match of line.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
      const destination = match[1].trim();
      const target = /^<([^>]*)>/.exec(destination)?.[1] ?? destination.split(/\s+/)[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('//')) continue;
      let path = target.split('#')[0].replace(/^\.\//, '');
      try { path = decodeURIComponent(path); } catch { /* keep it as written */ }
      if (!recordName.test(posix.basename(path))) continue;
      const resolved = path.startsWith('/') ? posix.normalize(path.slice(1)) : posix.join(directory, path);
      if (!exists(resolved)) {
        problem(`${directory}/README.md:${index + 1}`, `index links a record that does not exist: ${target}`);
      } else if (posix.dirname(resolved) === directory) {
        indexed.add(posix.basename(resolved));
      }
    }
  }
  for (const file of records) {
    if (!indexed.has(file)) problem(`${directory}/${file}`, `record is missing from ${directory}/README.md`);
  }
}

try {
  const baseRef = process.argv[2];
  if (!baseRef || process.argv.length !== 3) throw new Error('scripts/check-adrs.mjs: usage: node scripts/check-adrs.mjs <base-ref>');
  // The ADR directories are pathspecs, which git reads from the current directory: from a subdirectory
  // they would match nothing and every check would pass.
  process.chdir(git('scripts/check-adrs.mjs', 'rev-parse', '--show-toplevel').trim());
  const base = tree(baseRef);
  const head = tree('HEAD');
  const basePaths = paths(base, ...directories);
  const headPaths = paths(head, ...directories);
  // An index may link records of another directory; their existence is read from the whole HEAD tree.
  let allPaths;
  const exists = (path) => headPaths.has(path) || (allPaths ??= paths(head)).has(path);
  for (const directory of directories) {
    const records = (files) => [...files].filter((file) => file.startsWith(`${directory}/`) && recordName.test(file.slice(directory.length + 1)))
      .map((file) => file.slice(directory.length + 1));
    const baseRecords = records(basePaths);
    const headRecords = records(headPaths);
    for (const name of baseRecords) {
      const file = `${directory}/${name}`;
      if (!headPaths.has(file)) {
        problem(file, 'records on the base must not be deleted or renamed (if the base gained this record after the pull request\'s merge commit was made, update the branch)');
      } else {
        checkRecord(file, blob(base, file), blob(head, file));
      }
    }
    for (const name of headRecords.filter((name) => !baseRecords.includes(name))) {
      const file = `${directory}/${name}`;
      if (record(blob(head, file)).statusLine === null) {
        problem(file, 'added record has no front matter status field (MADR 4: line 1 is "---", then "status: proposed")');
      }
    }
    checkNumbers(directory, baseRecords, headRecords);
    const index = `${directory}/README.md`;
    if (headRecords.length || headPaths.has(index) || baseRecords.length) {
      checkIndex(directory, headRecords, git(index, 'show', `${head}:${index}`), exists);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

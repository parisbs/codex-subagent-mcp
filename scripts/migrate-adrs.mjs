#!/usr/bin/env node
// Issue #66 (ADR 0020): rewrites every legacy ADR of a repository into MADR 4 front matter, mechanically, so
// that scripts/check-adrs.mjs admits the change whatever the base status. Usage, from inside the
// repository: node scripts/migrate-adrs.mjs. It rewrites the working tree of docs/adr/, docs/adrs/ and
// docs/decisions/, leaves records already in the standard format unchanged, names on stderr each record it
// cannot migrate and leaves that record unchanged, and exits 1 when it named any.
// A legacy record has one "- Status:" or "Status:" line and at most one "- Date:" line. The result is
// "---", "status: <value>", "date: <value>" when there was a date, "---", then every other line unchanged:
// no blank line added or collapsed, because the check proves the migration by that identity.
// The repo-bootstrap templates carry a copy of this file: change it here, then install.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const directories = ['docs/adr', 'docs/adrs', 'docs/decisions'];
const recordName = /^\d{4}-[^/]+\.md$/;
const legacyStatus = /^(?:- Status:|Status:)/;
const legacyDate = /^- Date:/;
// Only ASCII blanks are trimmed, as scripts/check-adrs.mjs trims them.
const trim = (text) => text.replace(/^[ \t]+|[ \t]+$/g, '');

let named = false;
function cannot(file, reason) {
  console.error(`${file}: not migrated: ${reason}`);
  named = true;
}

// Plain YAML would misread these values, as a different string, a mapping, a comment or a line break, so
// they are double-quoted, escaping backslash and double quote. Values YAML reads as another type, such as
// true or a date, stay plain: the check reads them as text either way. U+0085 never gets here: YAML folds it
// even inside quotes, so such a record is named instead.
function scalar(value) {
  const plain = value !== '' && value === value.trim() && !/:[ \t]/.test(value) && !/[ \t]#/.test(value) &&
    !value.endsWith(':') && !/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) && !/[\u2028\u2029]/.test(value);
  return plain ? value : `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

// A record already in front matter is left as it is; one without a single status field that holds more
// than blanks is named, because the check counts it as missing a status.
function hasStatus(lines, end) {
  const statuses = lines.slice(1, end).filter((line) => /^status:(?:[ \t]|$)/.test(line));
  if (statuses.length !== 1) return false;
  const value = trim(statuses[0].slice('status:'.length));
  const inner = /^(["'])(.*)\1$/.exec(value)?.[2] ?? value;
  return /[^ \t]/.test(inner);
}

// The check compares records byte for byte, so a record is rewritten only when its text round-trips: bytes
// that are not valid UTF-8 would come back as U+FFFD, and a byte order mark would be dropped.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function migrate(file) {
  const bytes = readFileSync(file);
  // Front matter is read from its ASCII markers alone, and such a record is never written.
  if (bytes.toString('latin1').split('\n')[0] === '---') {
    const lines = bytes.toString('latin1').split('\n');
    const end = lines.indexOf('---', 1);
    if (end < 0) cannot(file, 'its front matter on line 1 is not closed');
    else if (!hasStatus(lines, end)) cannot(file, 'it has front matter without a single, non-empty status field');
    return;
  }
  let text;
  try {
    text = utf8.decode(bytes);
  } catch {
    return cannot(file, 'it is not valid UTF-8, so rewriting it would change bytes the check compares');
  }
  const lines = text.split('\n');
  const statusAt = lines.flatMap((line, index) => (legacyStatus.test(line) ? [index] : []));
  const dateAt = lines.flatMap((line, index) => (legacyDate.test(line) ? [index] : []));
  if (statusAt.length === 0) return cannot(file, 'no legacy status line ("- Status:" or "Status:")');
  if (statusAt.length > 1) return cannot(file, `${statusAt.length} legacy status lines (lines ${statusAt.map((index) => index + 1).join(', ')})`);
  if (dateAt.length > 1) return cannot(file, `${dateAt.length} "- Date:" lines (lines ${dateAt.map((index) => index + 1).join(', ')})`);
  const status = trim(lines[statusAt[0]].replace(legacyStatus, ''));
  if (status === '') return cannot(file, `its legacy status line ${statusAt[0] + 1} is empty`);
  const date = dateAt.length ? trim(lines[dateAt[0]].slice('- Date:'.length)) : null;
  if (`${status}${date ?? ''}`.includes('\u0085')) return cannot(file, 'its legacy status or date holds U+0085, which YAML folds even inside quotes');
  const front = ['---', `status: ${scalar(status)}`];
  if (date !== null) front.push(`date: ${scalar(date)}`);
  front.push('---');
  const kept = lines.filter((_, index) => index !== statusAt[0] && index !== dateAt[0]);
  writeFileSync(file, [...front, ...kept].join('\n'));
}

try {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.error || top.status !== 0) {
    throw new Error(`scripts/migrate-adrs.mjs: not inside a git repository (${top.error?.message ?? top.stderr.trim()})`);
  }
  process.chdir(top.stdout.trim());
  for (const directory of directories) {
    if (!existsSync(directory)) continue;
    const names = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && recordName.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    for (const name of names) migrate(`${directory}/${name}`);
  }
  if (named) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

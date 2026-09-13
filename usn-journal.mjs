import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX_JOURNAL_OUTPUT = 64 * 1024 * 1024;

const normalizeId = value => value.toLowerCase().replace(/^0x/, '').padStart(16, '0');

function csvFields(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      fields.push(field);
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('Malformed USN CSV record');
  fields.push(field);
  return fields;
}

function headerValues(output) {
  const values = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/:\s*(0x[0-9a-f]+|[0-9]+)/i);
    if (match) values.push(match[1]);
    if (values.length === 4) break;
  }
  if (values.length < 3) throw new Error('Unrecognized fsutil USN header');
  return values.map(value => BigInt(value));
}

export function parseUsnQuery(output) {
  const [journalId, firstUsn, nextUsn] = headerValues(output);
  return {
    journalId: journalId.toString(16),
    firstUsn: firstUsn.toString(),
    nextUsn: nextUsn.toString(),
  };
}

export function parseUsnRead(output) {
  const [journalId, firstUsn, nextUsn] = headerValues(output);
  const records = [];
  for (const line of output.split(/\r?\n/)) {
    if (!/^[0-9]+,/.test(line)) continue;
    const fields = csvFields(line);
    if (fields.length < 14 || !/^[0-9a-f]{1,32}$/i.test(fields[8]) || !/^[0-9a-f]{1,32}$/i.test(fields[9])) {
      throw new Error('Unrecognized fsutil USN record');
    }
    const attributes = Number.parseInt(fields[6].replace(/^0x/i, ''), 16);
    records.push({
      usn: fields[0],
      name: fields[1],
      reason: fields[3].toLowerCase(),
      fileId: normalizeId(fields[8]),
      parentId: normalizeId(fields[9]),
      directory: (attributes & 0x10) !== 0,
    });
  }
  return {
    journalId: journalId.toString(16),
    firstUsn: firstUsn.toString(),
    nextUsn: nextUsn.toString(),
    records,
  };
}

export function createFsutilUsnJournal(roots, platform = process.platform) {
  if (platform !== 'win32') return null;
  const volumes = new Set(roots.map(root => path.parse(path.resolve(root)).root.toUpperCase()));
  if (volumes.size !== 1) return null;
  const volumeRoot = [...volumes][0];
  if (!/^[A-Z]:\\$/.test(volumeRoot)) return null;
  const volume = volumeRoot.slice(0, 2);
  return {
    async query() {
      const { stdout } = await run('fsutil.exe', ['usn', 'queryjournal', volume], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      return parseUsnQuery(stdout);
    },
    async read(startUsn) {
      const start = BigInt(startUsn);
      const { stdout } = await run(
        'fsutil.exe',
        ['usn', 'readjournal', volume, `startusn=0x${start.toString(16)}`, 'minver=2', 'maxver=2', 'csv'],
        { encoding: 'utf8', windowsHide: true, maxBuffer: MAX_JOURNAL_OUTPUT },
      );
      return parseUsnRead(stdout);
    },
  };
}

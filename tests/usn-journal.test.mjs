import test from 'node:test';
import assert from 'node:assert/strict';
import { createFsutilUsnJournal, parseUsnQuery, parseUsnRead } from '../adapter/dist/usn-journal.mjs';

test('USN query parser reads locale-independent ordered numeric fields', () => {
  const parsed = parseUsnQuery([
    'Journal label : 0xabc',
    'First label   : 0x10',
    'Next label    : 0x20',
    'Other label   : 0x0',
  ].join('\r\n'));
  assert.deepEqual(parsed, { journalId: 'abc', firstUsn: '16', nextUsn: '32' });
});

test('USN CSV parser preserves quoted names and extracts stable numeric identifiers', () => {
  const output = [
    'Journal : 0xabc',
    'First   : 16',
    'Next    : 32',
    'Start   : 16',
    '',
    'Usn,File name,File name length,Reason #,Reason,Time stamp,File attributes #,File attributes,File ID,Parent file ID,Source info #,Source info,Security ID,Major version,Minor version,Record length,Number of extents',
    '20,"한글, ""quoted"".txt",20,0x80000001,"Data overwrite | Close","2026-09-13",0x00000020,"Archive",0002000000397cb0,000100000000001d,0x00000000,"*NONE*",0,2,0,96,0',
  ].join('\r\n');
  const parsed = parseUsnRead(output);
  assert.equal(parsed.nextUsn, '32');
  assert.deepEqual(parsed.records, [{
    usn: '20',
    name: '한글, "quoted".txt',
    reason: '0x80000001',
    fileId: '0002000000397cb0',
    parentId: '000100000000001d',
    directory: false,
  }]);
  assert.equal(createFsutilUsnJournal(['F:\\workspace'], 'linux'), null);
});

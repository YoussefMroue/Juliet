import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openPortfolio} from './portfolio.js';

// Simulate createWritable's save-on-close contract without touching personal folders.
function disk() {
  const files = new Map();
  let fault = null;
  const folder = {
    entries: () => files.entries(),
    getFileHandle(name) {
      if (files.has(name)) return files.get(name);
      let bytes = '';
      const handle = {
        getFile: async () => new Blob([bytes]),
        createWritable: async () => {
          let pending = '';
          return {
            write(text) { pending = text; },
            close() {
              if (fault === 'before') throw new Error('disk unavailable');
              bytes = pending;
              if (fault === 'after') throw new Error('acknowledgement unavailable');
            },
            abort() { pending = ''; }
          };
        }
      };
      files.set(name, handle);
      return handle;
    },
    removeEntry(name) { files.delete(name); }
  };
  let tail = Promise.resolve();
  const locks = {request(name, opts, callback) {
    const result = tail.then(callback || opts);
    tail = result.catch(() => {});
    return result;
  }};
  return {open: () => openPortfolio({getDirectoryHandle: name => { assert.equal(name, 'Juliet Portfolio'); return folder; }}, locks), folder, files, fail: value => { fault = value; }};
}
const base = {sponsor: 'DEMO', originalDate: '2026-11-03', sequence: 1, status: 'Drafting', nextAction: 'Read fictional solicitation', internalDue: '2026-11-15T13:00', internalZone: 'America/Chicago', sponsorDue: '2026-11-20T15:00', sponsorZone: 'America/New_York'};
const requirement = {category: 'Subaward', name: 'Subaward A budget', requirement: 'Required', source: 'Fictional opportunity, section IV'};

test('proposal records survive reopen; one folder supports simultaneous proposals with similar labels', async () => {
  const fixture = disk();
  const store = await fixture.open();
  const [a, b] = await Promise.all([store.create(base), store.create({...base, sequence: 2})]);
  assert.notEqual(a.id, b.id);
  assert.equal(a.label, 'DEMO-2026-11-03');
  assert.equal(b.label, 'DEMO-2026-11-03-02');
  await assert.rejects(store.create(base), /already identify/);
  const fromDisk = await (await fixture.open()).list();
  assert.deepEqual(fromDisk, [a, b]);
  assert.equal(fromDisk[0].internalDue, '2026-11-15T13:00');
  assert.equal(fromDisk[0].sponsorZone, 'America/New_York');
});

test('stale selections cannot overwrite edits; distinct proposals can be updated concurrently', async () => {
  const fixture = disk();
  const first = await fixture.open();
  const second = await fixture.open();
  const a = await first.create(base), b = await second.create({...base, sequence: 2});
  const writes = await Promise.allSettled([first.save(a, 'details', {...base, status: 'In review'}), second.save(a, 'details', {...base, status: 'Submitted'}), second.save(b, 'details', {...base, nextAction: 'Request attachment'})]);
  assert.equal(writes[0].status, 'fulfilled');
  assert.match(writes[1].reason.message, /Refresh/);
  assert.equal(writes[2].status, 'fulfilled');
  const [x,y] = await first.list();
  assert.equal(x.status, 'In review');
  assert.equal(y.status, 'Drafting');
  assert.equal(y.nextAction, 'Request attachment');
});

test('rounds preserve requirements, missing versions and earlier labels; cross-proposal document and review ids fail', async () => {
  const fixture = disk();
  const store = await fixture.open();
  let a = await store.create(base);
  const b = await store.create({...base, sequence: 2});
  a = await store.save(a, 'requirement', requirement);
  const documentId = a.documents[0].id;
  a = await store.save(a, 'round', {label: 'Initial screening'});
  await assert.rejects(store.save(b, 'review', {roundId: a.rounds[0].id, disposition: 'Accepted', note: 'Misrouted'}), /round from this proposal/);
  await assert.rejects(store.save(b, 'version', {documentId, label: 'Crossed'}), /document from this proposal/);
  await assert.rejects(store.save(b, 'requirement', {...requirement, documentId}), /different proposal/);
  a = await store.save(a, 'version', {documentId, label: 'Fictional revision A'});
  a = await store.save(a, 'requirement', {...requirement, documentId, name: 'Cost detail A'});
  a = await store.save(a, 'round', {label: 'Second look'});
  a = await store.save(a, 'version', {documentId, label: 'Fictional revision B'});
  a = await store.save(a, 'review', {roundId: a.rounds[0].id, disposition: 'Deferred', note: 'Confirm source citation'});
  const [reopened, other] = await (await fixture.open()).list();
  assert.deepEqual(reopened.rounds.map(r => r.documents.map(d => [d.name, d.version?.label])), [[['Subaward A budget', undefined]], [['Cost detail A', 'Fictional revision A']]]);
  assert.equal(reopened.reviews[0].roundId, reopened.rounds[0].id);
  assert.equal(reopened.documents[0].versions.length, 2);
  assert.equal(other.reviews.length + other.documents.length + other.rounds.length, 0);
  assert.equal(reopened.status, 'Drafting');
});

test('invalid fields and foreign selected head have no persistence side effects', async () => {
  const fixture = disk();
  const store = await fixture.open();
  for (const patch of [{sponsor:'../private'}, {sequence:0}, {sponsorDue:'2026-02-30T12:00'}, {sponsorZone:''}, {status:'Certified'}, {internalZone:'no/such_zone'}]) {
    await assert.rejects(store.create({...base, ...patch}));
    assert.equal(fixture.files.size, 0);
  }
  const a = await store.create(base), b = await store.create({...base, sequence: 2});
  await assert.rejects(store.save({...a, id: b.id}, 'details', base), /changed/);
  await assert.rejects(store.save(a, 'round', {label:'Empty'}), /requirement/);
  assert.equal(fixture.files.size, 2);
});

test('a failed write can retry safely; acknowledged-late writes are preserved and a stale retry fails', async () => {
  const fixture = disk();
  const store = await fixture.open();
  const a = await store.create(base);
  fixture.fail('before');
  await assert.rejects(store.save(a, 'requirement', requirement), /disk unavailable/);
  assert.equal(fixture.files.size, 1);
  fixture.fail('after');
  await assert.rejects(store.save(a, 'requirement', requirement), /acknowledgement/);
  fixture.fail(null);
  await assert.rejects(store.save(a, 'requirement', requirement), /Refresh/);
  assert.equal((await store.list())[0].documents.length, 1);
});

test('wrong filenames, partial journal entries and divergent device history fail closed', async () => {
  for (const condition of ['partial', 'fork', 'moved']) {
    const fixture = disk();
    const store = await fixture.open();
    const a = await store.create(base);
    await store.save(a, 'requirement', requirement);
    const [name, file] = [...fixture.files].at(-1);
    const id = crypto.randomUUID();
    const additional = fixture.folder.getFileHandle(`${a.id}_${id}.json`);
    if (condition !== 'partial') {
      const event = JSON.parse(await (await file.getFile()).text());
      if (condition === 'fork') event.id = id;
      const stream = await additional.createWritable();
      await stream.write(JSON.stringify(event)); await stream.close();
    }
    await assert.rejects(store.list(), /incomplete|identity|Conflicting/);
    assert(fixture.files.has(name));
  }
});

test('receipt and validated findings stay in one round; repeat imports are idempotent and conflicts fail', async () => {
  const fixture = disk();
  const store = await fixture.open();
  let a = await store.create(base), b = await store.create({...base, sequence: 2});
  a = await store.save(a, 'requirement', requirement);
  b = await store.save(b, 'requirement', requirement);
  a = await store.save(a, 'round', {label: 'Round A'});
  a = await store.save(a, 'round', {label: 'Round B'});
  b = await store.save(b, 'round', {label: 'Other round'});
  const packet = {roundId: a.rounds[0].id, packetId: crypto.randomUUID(), digest: 'a'.repeat(64)};
  a = await store.save(a, 'packet', {...packet, unsignedExtra:'FICTIONAL-PRIVATE-EXCERPT'});
  const receiptHead = a.head;
  a = await store.save(a, 'packet', packet);
  assert.equal(a.head, receiptHead);
  await assert.rejects(store.save(b, 'packet', {...packet, roundId: b.rounds[0].id}), /another record/);
  const finding = {type: 'question', message: '<img src=invalid> Confirm the dates.', evidence: [{itemId:'E1',quote:'Fictional excerpt'}], guidance: []};
  const report = {...packet, reportId: crypto.randomUUID(), findings: [finding], coverage: {reviewed:['E1'], unreviewed: ['E2']}};
  for (const patch of [{roundId:a.rounds[1].id}, {digest:'b'.repeat(64)}, {coverage:{reviewed:['E1'], unreviewed:['E1']}}, {findings:[{...finding,evidence:[{itemId:'OTHER',quote:'Example'}]}]}]) await assert.rejects(store.save(a, 'report', {...report, ...patch}));
  a = await store.save(a, 'report', report);
  const head = a.head;
  a = await store.save(a, 'report', report);
  assert.equal(a.head, head);
  await assert.rejects(store.save(a, 'report', {...report, coverage:{reviewed:['E1','E2'], unreviewed:[]}}), /different/);
  await assert.rejects(store.save(a, 'report', {...report, findings:[]}), /different/);
  const review = {roundId: a.rounds[0].id, reportId: report.reportId, index: 0, disposition: 'Deferred', note: 'Awaiting answer'};
  await assert.rejects(store.save(a, 'review', {...review, roundId: a.rounds[1].id}), /finding from this/);
  a = await store.save(a, 'review', review);
  const [reopened, other] = await store.list();
  const rawRecords = await Promise.all([...fixture.files.values()].map(async f => (await f.getFile()).text()));
  assert(!rawRecords.some(text => text.includes('FICTIONAL-PRIVATE-EXCERPT')));
  assert.equal(reopened.reports[0].findings[0].message, finding.message);
  assert.deepEqual(reopened.reports[0].coverage, report.coverage);
  assert.equal(reopened.status, 'Drafting');
  assert.equal(reopened.reviews[0].reportId, report.reportId);
  assert.equal(other.reports.length + other.packets.length + other.reviews.length, 0);
});

test('invalidated selection cancels an in-flight write before commit', async () => {
  const fixture = disk();
  const store = await fixture.open();
  const a = await store.create(base);
  let checks = 0;
  await assert.rejects(store.save(a, 'requirement', requirement, () => {
    if (++checks === 2) throw Error('obsolete context');
  }), /obsolete context/);
  assert.equal(fixture.files.size, 1);
  assert.deepEqual(await store.list(), [a]);
});

test('returned locations refer to frozen document versions and retain only verified source metadata', async () => {
  const fixture = disk(), store = await fixture.open();
  let p = await store.create(base);
  p = await store.save(p, 'requirement', requirement);
  const documentId = p.documents[0].id;
  p = await store.save(p, 'version', {documentId, label: 'Source version 1'});
  p = await store.save(p, 'round', {label: 'Review version 1'});
  const round = p.rounds[0], versionId = round.documents[0].version.id;
  p = await store.save(p, 'version', {documentId, label: 'Later version'});
  const packet = {roundId: round.id, packetId: crypto.randomUUID(), digest: 'b'.repeat(64)};
  p = await store.save(p, 'packet', packet);
  const report = {...packet, reportId: crypto.randomUUID(), coverage:{reviewed:['E1'], unreviewed:['E2']}, findings:[]};
  const loc = {documentId, versionId, itemId:'E1', anchor:'Sheet A!C2'};
  const second = {...loc, itemId:'E2', anchor:'Sheet A!D4'};
  for (const locations of [[loc], [loc,loc], [loc,{...second,documentId:crypto.randomUUID()}], [loc,{...second,versionId:p.documents[0].versions.at(-1).id}]]) {
    await assert.rejects(store.save(p, 'report', {...report, locations}), /location/);
  }
  p = await store.save(p, 'report', {...report, locations:[second,{...loc, rawText:'SHOULD NOT BE STORED'}]});
  const before = p.head;
  p = await store.save(p, 'report', {...report, locations:[loc,second]});
  assert.equal(p.head, before);
  await assert.rejects(store.save(p, 'report', {...report, locations:[{...loc, anchor:'Wrong anchor'},second]}), /different locations/);
  const [reopened] = await store.list();
  assert.deepEqual(reopened.reports[0].locations, [loc,second]);
  for (const h of fixture.files.values()) assert(!(await (await h.getFile()).text()).includes('SHOULD NOT BE STORED'));
});

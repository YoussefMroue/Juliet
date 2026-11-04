import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openPortfolio,activeVersion,activeHolds,currentCloseout,needsRecheck,unresolvedFindings} from './portfolio.js';
import {sealPacketSet,packetRegistration,verifyPacket,verifyReport} from './packet.js';

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

const reviewContext = {
  lane: 'budget', purpose: 'initial', opportunity: 'Fictional notice 2026, edition 1',
  scope: 'Reconcile the current annual budget and justification; no narrative rewriting.',
  requestedChecks: ['calculations', 'consistency'], guidanceStatus: 'missing', owner: 'Administrator',
  nextAction: 'Obtain the vendor quote', calculationEvidence: 'independent',
  calculationNote: 'Invented Year 1 inputs recomputed; no Excel run or external links.',
  narrativePermission: 'not_requested', handling: 'fictional_only'
};
async function scopedProposal(store, sequence = 1) {
  let p = await store.create({...base, sequence});
  p = await store.save(p, 'requirement', {...requirement, category: 'Budget', name: 'Annual budget'});
  p = await store.save(p, 'version', {documentId: p.documents[0].id, label: 'Fictional budget v1'});
  return store.save(p, 'round', {label: 'First scoped round', reviewContext, activeVersionsConfirmed: true});
}
async function addContextReport(store, p, {priorFindingId = null, followups = []} = {}) {
  const round = p.rounds.at(-1);
  const packet = {roundId: round.id, packetId: crypto.randomUUID(), digest: 'c'.repeat(64)};
  p = await store.save(p, 'packet', packet);
  const reportId = crypto.randomUUID();
  const report = {...packet, reportId, requiredFollowups: followups, coverage: {reviewed: ['E1'], unreviewed: []},
    locations: [{itemId: 'E1', documentId: round.documents[0].id, versionId: round.documents[0].version.id, anchor: 'Budget!B5'}],
    findings: [{type: 'question', message: 'The vendor quote is still needed.', evidence: [{itemId: 'E1', quote: 'Quote pending'}], guidance: [],
      id: priorFindingId ?? `${reportId}/F1`, gapIds: followups.map(f => f.id), priorFindingId,
      owner: 'Administrator', nextAction: 'Obtain the vendor quote', calculation: ''}]};
  p = await store.save(p, 'report', report);
  return {p, report};
}
function carryGap(findingId) {
  return {id: 'G1', type: 'question', documentId: null, priorFindingId: findingId,
    message: 'The earlier vendor quote issue remains unresolved.', nextAction: 'Obtain the vendor quote'};
}

test('scoped rounds freeze review context and derive prior identities only from their own history', async () => {
  const fixture = disk(), store = await fixture.open();
  let p = await scopedProposal(store);
  const first = structuredClone(p.rounds[0]);
  const context = {...reviewContext, purpose: 'revision', scope: 'Targeted check of a fictional correction.'};
  p = await store.save(p, 'round', {label: 'Second round', reviewContext: context, activeVersionsConfirmed: true, priorFindings: [{findingId: `${crypto.randomUUID()}/F1`}]});
  context.scope = 'Caller mutation must not change stored data';
  assert.deepEqual(p.rounds[0], first);
  assert.equal(p.rounds[1].reviewContext.scope, 'Targeted check of a fictional correction.');
  assert.deepEqual(p.rounds[1].priorFindings, []);
  const before = fixture.files.size;
  await assert.rejects(store.save(p, 'round', {label: 'Unconfirmed active versions', reviewContext}), /Confirm.*active/);
  for (const patch of [{scope: ''}, {requestedChecks: []}, {handling: 'approved_real_data'}, {calculationEvidence: 'excel', calculationNote: ''}]) {
    await assert.rejects(store.save(p, 'round', {label: 'Invalid', reviewContext: {...reviewContext, ...patch}, activeVersionsConfirmed: true}));
  }
  assert.equal(fixture.files.size, before);
  assert.deepEqual((await (await fixture.open()).list())[0].rounds, p.rounds);
});

test('v2 follow-ups and fields survive reopen, retries compare them, and foreign references fail', async () => {
  const fixture = disk(), store = await fixture.open();
  let p = await scopedProposal(store);
  const followups = [{id: 'G1', type: 'question', documentId: p.documents[0].id, priorFindingId: null,
    message: 'A fictional budget question remains open.', nextAction: 'Obtain the vendor quote'}];
  const result = await addContextReport(store, p, {followups}); p = result.p;
  const {report} = result, saved = p.reports[0], head = p.head;
  assert.equal((await store.save(p, 'report', report)).head, head);
  await assert.rejects(store.save(p, 'report', {...report, requiredFollowups: [{...followups[0], nextAction: 'Different next action'}]}), /different required follow-ups/);
  await assert.rejects(store.save(p, 'report', {...report, findings: [{...report.findings[0], owner: 'Different role'}]}), /different findings/);
  await assert.rejects(store.save(p, 'report', {...report, requiredFollowups: undefined}), /different required follow-ups/);
  for (const gap of [{...followups[0], documentId: crypto.randomUUID()}, {...followups[0], priorFindingId: `${crypto.randomUUID()}/F1`}]) {
    await assert.rejects(store.save(p, 'report', {...report, requiredFollowups: [gap]}), /foreign/);
  }
  const [reopened] = await (await fixture.open()).list();
  assert.deepEqual(reopened.reports[0], saved);
  assert.equal(reopened.reports[0].findings[0].owner, 'Administrator');
  assert.equal(reopened.status, 'Drafting');
});

test('corrected and legacy resolved findings carry forward once with the original identity and owner', async () => {
  const fixture = disk(), store = await fixture.open();
  let p = await scopedProposal(store), other = await scopedProposal(store, 2);
  let result = await addContextReport(store, p); p = result.p;
  const originalId = result.report.findings[0].id;
  p = await store.save(p, 'review', {roundId: p.rounds[0].id, reportId: result.report.reportId, index: 0, disposition: 'Corrected', note: 'A correction was reported; quote still needed.'});
  p = await store.save(p, 'round', {label: 'Recheck', reviewContext: {...reviewContext, purpose: 'revision'}, activeVersionsConfirmed: true});
  assert.deepEqual(p.rounds[1].priorFindings, [{findingId: originalId, message: 'The vendor quote is still needed.', type: 'question', owner: 'Administrator', nextAction: 'Obtain the vendor quote', disposition: 'Corrected'}]);
  const frozen = structuredClone(p.rounds[1]);
  result = await addContextReport(store, p, {priorFindingId: originalId, followups: [carryGap(originalId)]}); p = result.p;
  assert.equal(p.reports[1].findings[0].id, originalId);
  assert.equal(p.reviews.length, 1, 'Importing a report must not create a decision');
  assert.equal(p.status, 'Drafting');
  p = await store.save(p, 'review', {roundId: p.rounds[1].id, reportId: result.report.reportId, index: 0, disposition: 'Resolved', note: 'Legacy label alone does not prove verification.'});
  p = await store.save(p, 'round', {label: 'Third round', reviewContext, activeVersionsConfirmed: true});
  assert.equal(p.rounds[2].priorFindings.length, 1);
  assert.equal(p.rounds[2].priorFindings[0].findingId, originalId);
  assert.equal(p.rounds[2].priorFindings[0].disposition, 'Resolved');
  assert.deepEqual(p.rounds[1], frozen);
  other = await store.save(other, 'round', {label: 'Other proposal recheck', reviewContext, activeVersionsConfirmed: true});
  assert.deepEqual(other.rounds[1].priorFindings, []);
  const packet = {roundId: other.rounds[1].id, packetId: crypto.randomUUID(), digest: 'd'.repeat(64)};
  other = await store.save(other, 'packet', packet);
  await assert.rejects(store.save(other, 'report', {...result.report, ...packet, reportId: crypto.randomUUID()}), /foreign prior finding/);
  assert.equal((await store.list())[0].rounds[2].priorFindings.length, 1);
});

test('Verified requires the latest finding and active document evidence; closure preserves historical snapshots', async () => {
  const fixture = disk(), store = await fixture.open();
  let p = await scopedProposal(store);
  let result = await addContextReport(store, p); p = result.p;
  const firstRound = p.rounds[0], firstReport = result.report;
  const docId = p.documents[0].id;
  const review = {roundId: firstRound.id, reportId: firstReport.reportId, index: 0, disposition: 'Verified', note: 'Checked the supplied quote and affected budget.'};
  const verification = {documentId: docId, versionId: firstRound.documents[0].version.id, anchor: 'Budget!B5 and quote page 1'};
  for (const bad of [undefined, {...verification, documentId: crypto.randomUUID()}, {...verification, versionId: crypto.randomUUID()}, {...verification, anchor: ''}]) {
    await assert.rejects(store.save(p, 'review', {...review, verification: bad}));
  }
  await assert.rejects(store.save(p, 'review', {roundId: firstRound.id, disposition: 'Verified', note: 'Everything checked'}), /individual finding/);
  p = await store.save(p, 'version', {documentId: docId, label: 'Revised budget'});
  await assert.rejects(store.save(p, 'review', {...review, verification}), /newer version/);
  p = await store.save(p, 'round', {label: 'Verify current revision', reviewContext, activeVersionsConfirmed: true});
  const secondRound = p.rounds[1], id = firstReport.findings[0].id;
  result = await addContextReport(store, p, {priorFindingId: id, followups: [carryGap(id)]}); p = result.p;
  await assert.rejects(store.save(p, 'review', {...review, verification}), /newer version/);
  p = await store.save(p, 'review', {...review, roundId: secondRound.id, reportId: result.report.reportId,
    verification: {...verification, versionId: secondRound.documents[0].version.id}});
  p = await store.save(p, 'round', {label: 'After verified correction', reviewContext, activeVersionsConfirmed: true});
  assert.deepEqual(p.rounds[2].priorFindings, []);
  assert.equal(p.rounds[1].priorFindings[0].findingId, id);
  p = await store.save(p, 'version', {documentId: docId, label: 'Later revision after verification'});
  const [reopened] = await (await fixture.open()).list();
  assert.equal(reopened.reviews.at(-1).disposition, 'Verified');
  assert.equal(reopened.reviews.at(-1).verification.versionId, secondRound.documents[0].version.id);
  assert.equal(reopened.status, 'Drafting');
});

test('late reports are historical and cannot reopen a declined finding or replace current evidence', async () => {
  const fixture=disk(),store=await fixture.open();let p=await scopedProposal(store);
  const first=await addContextReport(store,p);p=first.p;const id=first.report.findings[0].id;
  p=await store.save(p,'round',{label:'Before decision',reviewContext,activeVersionsConfirmed:true});
  const round=p.rounds.at(-1),packet={roundId:round.id,packetId:crypto.randomUUID(),digest:'e'.repeat(64)};
  p=await store.save(p,'packet',packet);
  p=await store.save(p,'review',{roundId:p.rounds[0].id,reportId:first.report.reportId,index:0,disposition:'Declined',note:'No longer needed.'});
  const pending={...first.report,...packet,reportId:crypto.randomUUID(),requiredFollowups:[carryGap(id)],findings:[{...first.report.findings[0],priorFindingId:id,gapIds:['G1']}]};
  p=await store.save(p,'report',pending);
  assert.equal(p.reports.at(-1).historical,true);
  assert.deepEqual(unresolvedFindings(p),[]);
  assert.equal((await store.save(p,'report',pending)).head,p.head);
  await assert.rejects(store.save(p,'review',{roundId:round.id,reportId:pending.reportId,index:0,disposition:'Verified',note:'Historical',verification:{documentId:round.documents[0].id,versionId:round.documents[0].version.id,anchor:'B5'}}),/newer version/);
  p=await store.save(p,'round',{label:'After late import',reviewContext,activeVersionsConfirmed:true});
  assert.deepEqual(p.rounds.at(-1).priorFindings,[]);
  assert.equal((await (await fixture.open()).list())[0].reports.at(-1).historical,true);
});

test('large valid reports reopen and the unresolved-finding capacity is checked before any write', async () => {
  const fixture = disk(), store = await fixture.open();
  let p = await scopedProposal(store);
  const round = p.rounds[0];
  const packet = {roundId: round.id, packetId: crypto.randomUUID(), digest: 'f'.repeat(64)};
  p = await store.save(p, 'packet', packet);
  const reportId = crypto.randomUUID();
  const report = {...packet, reportId, requiredFollowups: [], coverage: {reviewed: ['E1'], unreviewed: []},
    findings: Array.from({length: 120}, (_, i) => ({type: 'question', message: '漢'.repeat(1000),
      evidence: Array.from({length: 6}, () => ({itemId: 'E1', quote: '文'.repeat(300)})), guidance: [],
      id: `${reportId}/F${i + 1}`, gapIds: [], priorFindingId: null, owner: '角'.repeat(100), nextAction: '次'.repeat(300), calculation: '計'.repeat(500)}))};
  assert(Buffer.byteLength(JSON.stringify(report)) > 512 * 1024);
  p = await store.save(p, 'report', report);
  const [reopened] = await (await fixture.open()).list();
  assert.equal(reopened.reports[0].findings.length, 120);
  assert.equal(reopened.reports[0].findings.at(-1).message, report.findings.at(-1).message);
  p = await store.save(p, 'round', {label: 'All unresolved findings retained', reviewContext, activeVersionsConfirmed: true});
  assert.equal(p.rounds.at(-1).priorFindings.length, 120);
  const later = {roundId: p.rounds.at(-1).id, packetId: crypto.randomUUID(), digest: 'a'.repeat(64)};
  p = await store.save(p, 'packet', later);
  const laterId = crypto.randomUUID();
  const extra = {...later, reportId: laterId, requiredFollowups: [], coverage: report.coverage,
    findings: [{...report.findings[0], id: `${laterId}/F1`, message: 'A genuinely new question.'}]};
  const before = fixture.files.size;
  await assert.rejects(store.save(p, 'report', extra), /exceed 120 unresolved findings/);
  await assert.rejects(store.save(p, 'report', {...extra, findings: [{...extra.findings[0], message: '漢'.repeat(3 * 1024 * 1024)}]}), /Check finding/);
  assert.equal(fixture.files.size, before, 'Rejected capacity or oversized text must not leave a journal entry');
  p = await store.save(p, 'review', {roundId: round.id, reportId, index: 0, disposition: 'Declined', note: 'Duplicate question; retain the other findings.'});
  p = await store.save(p, 'report', extra);
  p = await store.save(p, 'round', {label: 'After deliberate consolidation', reviewContext, activeVersionsConfirmed: true});
  assert.equal(p.rounds.at(-1).priorFindings.length, 120);
  assert.equal((await store.list())[0].reports.length, 2);
});

test('verification journals retain only validated version and location metadata', async () => {
  const fixture = disk(), store = await fixture.open();
  const initial = await scopedProposal(store);
  const result = await addContextReport(store, initial);
  const round = result.p.rounds[0];
  await store.save(result.p, 'review', {roundId: round.id, reportId: result.report.reportId, index: 0,
    disposition: 'Verified', note: 'Checked the fictional current evidence.',
    verification: {documentId: round.documents[0].id, versionId: round.documents[0].version.id, anchor: 'Budget!B5', rawText: 'PRIVATE-UNVALIDATED-TEXT-MUST-NOT-PERSIST'}});
  const texts = await Promise.all([...fixture.files.values()].map(async f => (await f.getFile()).text()));
  assert(!texts.some(text => text.includes('PRIVATE-UNVALIDATED')));
  assert.deepEqual((await store.list())[0].reviews[0].verification,
    {documentId: round.documents[0].id, versionId: round.documents[0].version.id, anchor: 'Budget!B5'});
});

async function v1Proposal(store,sequence=1) {
  let p=await store.create({...base,sequence});
  p=await store.save(p,'requirement',{...requirement,category:'Budget',name:'Budget'});
  p=await store.save(p,'version',{documentId:p.documents[0].id,label:'Original working copy',sha256:'1'.repeat(64),size:100,format:'xlsx',provenance:'original',coverage:'partial',limitations:[{location:'Budget!C10',feature:'external_link',message:'Linked source not supplied.'}],activate:true});
  p=await store.save(p,'check',{label:'Inspect the current figures',applicability:'required',basis:'Requested review scope',documentIds:[p.documents[0].id],sourceDocumentIds:[],owner:'Lynn',nextAction:''});
  p=await store.save(p,'round',{label:'V1 review',workflowVersion:3,checklistConfirmed:true,activeVersionsConfirmed:true,reviewContext:{...reviewContext,lane:'focused',requestedChecks:['consistency'],handling:'real_proposal'}});
  return p;
}
function v1Context(p) {
  const round=p.rounds.at(-1);
  return {proposalId:p.id,roundId:round.id,documents:round.documents,reviewContext:round.reviewContext,priorFindings:round.priorFindings,checklist:round.checklist,workflowVersion:3,heldCheckIds:round.heldCheckIds,wholeReviewHeld:activeHolds(p).some(h=>h.scope==='whole'),packets:p.packets.filter(x=>x.roundId===round.id)};
}
async function v1Report(store,p,{issue=false}={}) {
  let context=v1Context(p),doc=context.documents[0];
  const packets=await sealPacketSet(context,[{documentId:doc.id,anchor:'Budget!B8',text:'Four units at 875 total 3500.',provenance:{method:'manual',note:'Human inspection of the original version.'}}]);
  p=await store.save(p,'packet_set',{roundId:context.roundId,packets:packets.map(packetRegistration)});
  context=v1Context(p);
  for(const packet of packets) {
    await verifyPacket(context,packet);
    const findings=packet.requiredFollowups.map(g=>({type:g.type,message:g.message,evidence:[],guidance:[],gapIds:[g.id],priorFindingId:g.priorFindingId,owner:'Lynn',nextAction:g.nextAction,calculation:''}));
    if(issue)findings.push({type:'question',message:'Confirm the intended number of units.',evidence:[{itemId:'E1',quote:'Four units'}],guidance:[],gapIds:[],priorFindingId:null,owner:'Lynn',nextAction:'Inspect the source.',calculation:''});
    const raw={format:'juliet.findings.v3',reviewerRelease:'1.0.0',...Object.fromEntries(['proposalId','roundId','packetId','reportId','digest','packetSetId','batchId','batchIndex','batchCount','manifestDigest'].map(k=>[k,packet[k]])),coverage:{reviewed:packet.items.map(i=>i.itemId),unreviewed:[]},findings,checkResults:packet.assignedCheckIds.map(checkId=>({checkId,status:'checked',message:'The supplied current excerpt was inspected.',evidence:[{itemId:'E1',quote:'Four units'}],guidance:[],findingRefs:issue?['F'+findings.length]:[]}))};
    p=await store.save(p,'report',{roundId:context.roundId,...verifyReport(packet,raw)});
  }
  return {p,packets};
}

test('v1 active versions preserve source hashes, manual limitations and explicit selection',async()=>{
  const fixture=disk(),store=await fixture.open();let p=await v1Proposal(store);const doc=p.documents[0],first=doc.versions[0];
  p=await store.save(p,'version',{documentId:doc.id,label:'Supported derivative',sha256:'2'.repeat(64),size:90,format:'xlsx',provenance:'derivative',sourceVersionId:first.id,activate:false,coverage:'supported_text',limitations:[]});
  assert.equal(activeVersion(p.documents[0]).id,first.id);
  const newer=p.documents[0].versions.at(-1);
  await assert.rejects(store.save(p,'active_version',{documentId:doc.id,versionId:crypto.randomUUID()}),/version from this/);
  p=await store.save(p,'active_version',{documentId:doc.id,versionId:newer.id});
  assert.equal(activeVersion(p.documents[0]).sha256,'2'.repeat(64));
  assert.equal(p.rounds[0].documents[0].version.sha256,'1'.repeat(64));
  assert.equal(p.rounds[0].documents[0].version.limitations[0].feature,'external_link');
  assert.deepEqual((await (await fixture.open()).list())[0],p);
});

test('v1 atomic packet registration, structured results and version-bound closeout survive reopen',async()=>{
  const fixture=disk(),store=await fixture.open();let p=await v1Proposal(store);
  await assert.rejects(store.save(p,'details',{...base,status:'Ready for submission'}),/closeout/);
  const result=await v1Report(store,p);p=result.p;
  assert.equal(p.reports[0].checkResults[0].status,'checked');
  const before=p.head;
  p=await store.save(p,'packet_set',{roundId:p.rounds[0].id,packets:result.packets.map(packetRegistration)});
  assert.equal(p.head,before);
  const remaining=unresolvedFindings(p).map(f=>({findingId:f.findingId,owner:'Lynn',impact:'This limited inspection is sufficient for this fictional exercise.'}));
  const closeout={roundId:p.rounds[0].id,correctedFiles:[],noCorrectionsRequired:true,remaining,readyForRouting:true,reason:'Reviewed the active copy and all stated limits.',nextAction:'Route manually through the institution.'};
  p=await store.save(p,'closeout',closeout);
  assert(currentCloseout(p)?.readyForRouting);
  assert.equal(p.status,'Drafting');
  p=await store.save(p,'details',{...base,status:'Ready for submission'});
  assert.equal(p.status,'Ready for submission');
  p=await store.save(p,'version',{documentId:p.documents[0].id,label:'Later correction',activate:true});
  assert.equal(currentCloseout(p),null);
  assert.equal(p.status,'Ready for submission','A stale closeout must not silently change human status.');
  assert.equal((await (await fixture.open()).list())[0].closeouts.length,1);
});

test('v1 multiple holds clear independently and whole-review hold blocks sealing',async()=>{
  const fixture=disk(),store=await fixture.open();let p=await v1Proposal(store);const round=p.rounds[0];
  for(const scope of ['checks','whole'])p=await store.save(p,'hold',{roundId:round.id,scope,checkIds:scope==='checks'?[round.checklist[0].checkId]:[],reason:'Await guidance',owner:'Lynn',nextAction:'Inspect applicable instructions.'});
  assert.equal(activeHolds(p).length,2);
  await assert.rejects(sealPacketSet(v1Context(p),[]),/hold/);
  p=await store.save(p,'hold_clear',{holdId:p.holds[1].id,reason:'Independent checks may continue.'});
  assert.equal(activeHolds(p).length,1);
  const context=v1Context(p),packets=await sealPacketSet(context,[]);
  await assert.rejects(store.save(p,'packet_set',{roundId:round.id,packets:packets.map(packetRegistration)}),/scoped holds changed/);
  p=await store.save(p,'round',{label:'Scoped hold frozen',workflowVersion:3,checklistConfirmed:true,activeVersionsConfirmed:true,reviewContext:round.reviewContext});
  assert.deepEqual(p.rounds.at(-1).heldCheckIds,[round.checklist[0].checkId]);
  p=await store.save(p,'hold_clear',{holdId:p.holds[0].id,reason:'Current authority supplied locally.'});
  assert.equal(activeHolds(p).length,0);
  assert.deepEqual(p.rounds.at(-1).heldCheckIds,[round.checklist[0].checkId],'Clearing a hold must preserve the frozen round.');
});

test('v1 changed evidence flags verified findings without rewriting verification and late imports stay historical',async()=>{
  const fixture=disk(),store=await fixture.open();let p=await v1Proposal(store);
  p=(await v1Report(store,p,{issue:true})).p;
  const report=p.reports[0],index=report.findings.length-1,id=report.findings[index].id,doc=p.documents[0];
  p=await store.save(p,'review',{roundId:report.roundId,reportId:report.reportId,index,disposition:'Verified',note:'Inspected the current cells.',verification:{documentId:doc.id,versionId:activeVersion(doc).id,anchor:'Budget!B8'}});
  assert.equal(needsRecheck(p,id),false);
  p=await store.save(p,'version',{documentId:doc.id,label:'Changed wage calculation',activate:true});
  assert.equal(needsRecheck(p,id),true);
  assert.equal(p.reviews.at(-1).disposition,'Verified');
  assert.equal(unresolvedFindings(p).find(f=>f.findingId===id).disposition,'Needs recheck');
  p=await store.save(p,'round',{label:'Review affected totals and justification',workflowVersion:3,checklistConfirmed:true,activeVersionsConfirmed:true,reviewContext:p.rounds[0].reviewContext});
  assert.equal(p.rounds.at(-1).priorFindings.find(f=>f.findingId===id).disposition,'Needs recheck');
});

test('v1 missing batches and foreign checklist links cannot qualify for closeout',async()=>{
  const fixture=disk(),store=await fixture.open();let p=await v1Proposal(store),other=await v1Proposal(store,2);
  const context=v1Context(p),packets=await sealPacketSet(context,[]);
  const forged=packets.map(packetRegistration);forged[0].assignedCheckIds=[other.checklist[0].checkId];
  await assert.rejects(store.save(p,'packet_set',{roundId:context.roundId,packets:forged}),/assigned checklist/);
  const before=fixture.files.size;
  await assert.rejects(store.save(p,'closeout',{roundId:context.roundId,correctedFiles:[],noCorrectionsRequired:true,remaining:[],readyForRouting:true,reason:'Incomplete',nextAction:'Wait'}),/packet batch|checklist results/);
  assert.equal(fixture.files.size,before);
});

test('v1 permits one packet set per frozen round and rejects incomplete sets atomically',async()=>{
  const fixture=disk(),store=await fixture.open();let p=await v1Proposal(store);
  const context=v1Context(p),first=await sealPacketSet(context,[]),second=await sealPacketSet(context,[]);
  const bad=first.map(packetRegistration);bad[0].batchCount++;
  const before=fixture.files.size;
  await assert.rejects(store.save(p,'packet_set',{roundId:context.roundId,packets:bad}),/incomplete/);
  assert.equal(fixture.files.size,before);
  p=await store.save(p,'packet_set',{roundId:context.roundId,packets:first.map(packetRegistration)});
  await assert.rejects(store.save(p,'packet_set',{roundId:context.roundId,packets:second.map(packetRegistration)}),/already has a sealed packet set/);
  assert.equal(p.packets.length,1);
});

test('v1 corrected findings require active-file acknowledgment and cannot use no-corrections closeout',async()=>{
  const fixture=disk(),store=await fixture.open();let p=await v1Proposal(store);
  p=(await v1Report(store,p,{issue:true})).p;
  const report=p.reports[0];
  p=await store.save(p,'review',{roundId:report.roundId,reportId:report.reportId,index:report.findings.length-1,disposition:'Corrected',note:'The current working copy reflects the correction.'});
  const input={roundId:report.roundId,correctedFiles:[],noCorrectionsRequired:true,remaining:unresolvedFindings(p).map(f=>({findingId:f.findingId,owner:'Lynn',impact:'Awaiting targeted verification before routing.'})),readyForRouting:false,reason:'Review stopped pending inspection.',nextAction:'Inspect current file.'};
  await assert.rejects(store.save(p,'closeout',input),/corrections or verification/);
  const files=[{documentId:p.documents[0].id,versionId:activeVersion(p.documents[0]).id}];
  await assert.rejects(store.save(p,'closeout',{...input,correctedFiles:files}),/not both/);
  p=await store.save(p,'closeout',{...input,noCorrectionsRequired:false,correctedFiles:files});
  assert(currentCloseout(p));assert.equal(currentCloseout(p).readyForRouting,false);
  await assert.rejects(store.save(p,'details',{...base,status:'Ready for submission'}),/closeout/);
});

test('v1 verification cannot silently adopt a changed cross-document dependency',async()=>{
  const fixture=disk(),store=await fixture.open();let p=await v1Proposal(store);
  p=await store.save(p,'requirement',{category:'Budget justification',name:'Justification',requirement:'Required',source:''});
  const budget=p.documents[0],justification=p.documents[1];
  p=await store.save(p,'version',{documentId:justification.id,label:'Matching initial justification',activate:true});
  p=await store.save(p,'check',{...p.checklist[0],documentIds:[budget.id,justification.id]});
  p=await store.save(p,'round',{label:'Cross-document review',workflowVersion:3,checklistConfirmed:true,activeVersionsConfirmed:true,reviewContext:p.rounds[0].reviewContext});
  let context=v1Context(p);
  const [packet]=await sealPacketSet(context,[
    {documentId:budget.id,anchor:'Budget!B8',text:'Four units at 875 total 3500.'},
    {documentId:justification.id,anchor:'Paragraph 1',text:'Four units support the work.'}
  ]);
  p=await store.save(p,'packet_set',{roundId:context.roundId,packets:[packetRegistration(packet)]});
  const findings=packet.requiredFollowups.map(g=>({type:g.type,message:g.message,evidence:[],guidance:[],gapIds:[g.id],priorFindingId:g.priorFindingId,owner:'Lynn',nextAction:g.nextAction,calculation:''}));
  findings.push({type:'question',message:'Confirm the shared quantity.',evidence:[{itemId:'E1',quote:'Four units'},{itemId:'E2',quote:'Four units'}],guidance:[],gapIds:[],priorFindingId:null,owner:'Lynn',nextAction:'Inspect both active files.',calculation:''});
  const raw={format:'juliet.findings.v3',reviewerRelease:'1.0.0',...Object.fromEntries(['proposalId','roundId','packetId','reportId','digest','packetSetId','batchId','batchIndex','batchCount','manifestDigest'].map(k=>[k,packet[k]])),coverage:{reviewed:['E1','E2'],unreviewed:[]},findings,checkResults:[{checkId:packet.assignedCheckIds[0],status:'checked',message:'The supplied figures were compared.',evidence:[{itemId:'E1',quote:'Four units'},{itemId:'E2',quote:'Four units'}],guidance:[],findingRefs:['F'+findings.length]}]};
  p=await store.save(p,'report',{roundId:context.roundId,...verifyReport(packet,raw)});
  const decision={roundId:context.roundId,reportId:raw.reportId,index:findings.length-1,disposition:'Verified',note:'Inspected the budget cells.',verification:{documentId:budget.id,versionId:activeVersion(p.documents[0]).id,anchor:'Budget!B8'}};
  p=await store.save(p,'version',{documentId:justification.id,label:'Changed effort and quantities',activate:true});
  const before=fixture.files.size;
  await assert.rejects(store.save(p,'review',decision),/verification dependency changed/);
  assert.equal(fixture.files.size,before);
  assert.equal(p.reviews.length,0);
  p=await store.save(p,'active_version',{documentId:justification.id,versionId:context.documents[1].version.id});
  p=await store.save(p,'review',decision);
  const finding=p.reports[0].findings.at(-1).id;
  assert.equal(needsRecheck(p,finding),false);
  p=await store.save(p,'active_version',{documentId:justification.id,versionId:p.documents[1].versions.at(-1).id});
  assert.equal(needsRecheck(p,finding),true);
  assert.equal((await (await fixture.open()).list())[0].reviews[0].disposition,'Verified');
});

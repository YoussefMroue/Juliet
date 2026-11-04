import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sealPacket, verifyPacket, verifyReport} from './packet.js';
import {normalizeReviewContext, requiredFollowups} from './review-context.js';

const id = () => crypto.randomUUID();
function round() {
  return {proposalId:id(), roundId:id(), packets:[], documents:['Budget','Opportunity guidance'].map(category =>
    ({id:id(), category, version:{id:id()}}))};
}
// Fixed legacy serialization exercises compatibility independently of the new exporter.
async function legacyPacket(ctx, excerpts) {
  const body={format:'juliet.packet.v1',material:'fictional-excerpts',reviewerRelease:'0.1.0',proposalId:ctx.proposalId,roundId:ctx.roundId,packetId:id(),reportId:id(),items:excerpts.map((e,i)=>{const d=ctx.documents.find(d=>d.id===e.documentId);return {itemId:'E'+(i+1),documentId:d.id,versionId:d.version.id,category:d.category,anchor:e.anchor,text:e.text};})};
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(body)));
  return {...body,digest:Buffer.from(bytes).toString('hex')};
}
async function fixture() {
  const ctx = round();
  const p = await legacyPacket(ctx, [
    {documentId:ctx.documents[0].id, anchor:'Budget!B1', text:'One year total 1100.'},
    {documentId:ctx.documents[1].id, anchor:'Fictional guide v1, section 2', text:'Annual total limit 1000.'}
  ]);
  ctx.packets.push({packetId:p.packetId,digest:p.digest});
  const {reviewerRelease, proposalId, roundId, packetId, reportId, digest} = p;
  const report = {format:'juliet.findings.v1',reviewerRelease,proposalId,roundId,packetId,reportId,digest,
    coverage:{reviewed:['E1','E2'],unreviewed:[]},findings:[{type:'objective_error',message:'The request is 100 above the annual limit.',
      evidence:[{itemId:'E1',quote:'total 1100'}],guidance:[{itemId:'E2',quote:'limit 1000'}]}]};
  return {ctx,p,report};
}
test('identifies exact read-back bytes independent of JSON key order and verifies a cited finding',async()=>{
  const {ctx,p,report} = await fixture();
  assert.deepEqual(await verifyPacket(ctx,Object.fromEntries(Object.entries(p).reverse())),p);
  assert.deepEqual(verifyReport(p,report).findings,report.findings);
});
test('rejects foreign proposals, rounds, stale document versions and unregistered packets',async()=>{
  const {ctx,p,report} = await fixture();
  for (const changed of [{proposalId:id()},{roundId:id()},{packets:[]},{documents:round().documents}]) {
    await assert.rejects(verifyPacket({...ctx,...changed},p));
  }
  for (const key of ['proposalId','roundId','packetId','reportId','digest','reviewerRelease']) {
    assert.throws(()=>verifyReport(p,{...report,[key]:id()}));
  }
});
test('rejects changed contents, malformed coverage and unsupported claims',async()=>{
  const {ctx,p,report} = await fixture();
  const changed=structuredClone(p); changed.items[0].text+=' altered';
  await assert.rejects(verifyPacket(ctx,changed), /changed/);
  assert.throws(()=>verifyReport(p,{...report,coverage:{reviewed:['E1','E1'],unreviewed:[]}}));
  const f=report.findings[0];
  for (const fake of [{guidance:[{itemId:'E1',quote:'total 1100'}]}, {guidance:[]}, {evidence:[]},
    {guidance:[{itemId:'E2',quote:'invented rule'}]},{type:'approved'},{submit:true}]) {
    assert.throws(()=>verifyReport(p,{...report,findings:[{...f,...fake}]}));
  }
  assert.throws(()=>verifyReport(p,{...report,findings:[],coverage:{reviewed:['E1'],unreviewed:['E2']}}));
});
test('supports explicit missing guidance questions and unreviewed coverage without invented citations',async()=>{
  const {p,report}=await fixture();
  const findings=['question','coverage_gap'].map(type=>({type,message:'Cannot establish which limit applies.',evidence:[],guidance:[]}));
  assert.deepEqual(verifyReport(p,{...report,coverage:{reviewed:['E1'],unreviewed:['E2']},findings}).findings,findings);
});
test('independent corroboration requires two separate proposal locations', async()=>{
  const {ctx,p,report} = await fixture();
  const guidanceAsEvidence = {...report.findings[0], evidence:[...report.findings[0].evidence,...report.findings[0].guidance],guidance:[]};
  assert.throws(()=>verifyReport(p,{...report,findings:[guidanceAsEvidence]}), /two distinct proposal locations/);
  const copies = await legacyPacket(ctx,['Budget!B1','budget!b1'].map(anchor =>
    ({documentId:ctx.documents[0].id,anchor,text:'One year total 1100.'})));
  const duplicated = {...report,packetId:copies.packetId,reportId:copies.reportId,digest:copies.digest,
    findings:[{...guidanceAsEvidence,evidence:['E1','E2'].map(itemId=>({itemId,quote:'total 1100'}))}]};
  assert.throws(()=>verifyReport(copies,duplicated), /two distinct proposal locations/);
  assert.equal(verifyReport(p,report).locations[1].anchor,'Fictional guide v1, section 2');
});

const scope = (patch={}) => ({lane:'focused',purpose:'initial',opportunity:'Fictional call, edition A',scope:'Check the supplied arithmetic only.',requestedChecks:['calculations'],guidanceStatus:'missing',owner:'Administrator',nextAction:'Check the fictional figures',calculationEvidence:'independent',calculationNote:'Recompute only the supplied line. No Excel engine run.',narrativePermission:'not_requested',handling:'fictional_only',...patch});
function scopedRound(patch={}) {
  const ctx=round();
  ctx.documents=ctx.documents.map(d=>({...d,name:d.category,requirement:'Optional',source:''}));
  ctx.reviewContext=scope(patch); ctx.priorFindings=[];
  return ctx;
}
const row=(patch={})=>({type:'question',message:'Confirm the fictional basis.',evidence:[],guidance:[],gapIds:[],priorFindingId:null,owner:'Administrator',nextAction:'Confirm the basis from supplied evidence.',calculation:'',...patch});
function scopedReport(p,findings) {
  const {reviewerRelease,proposalId,roundId,packetId,reportId,digest}=p;
  return {format:'juliet.findings.v2',reviewerRelease,proposalId,roundId,packetId,reportId,digest,coverage:{reviewed:p.items.map(i=>i.itemId),unreviewed:[]},findings:findings ?? p.requiredFollowups.map(g=>row({type:g.type,message:g.message,nextAction:g.nextAction,gapIds:[g.id],priorFindingId:g.priorFindingId}))};
}
async function scopedFixture(patch={}) {
  const ctx=scopedRound(patch);
  const p=await sealPacket(ctx,[{documentId:ctx.documents[0].id,anchor:'Year 2!C8:E8',text:'4 units at $875 each. Requested $3,600.'}]);
  ctx.packets.push({packetId:p.packetId,digest:p.digest});
  return {ctx,p,report:scopedReport(p)};
}
test('T01 single-location arithmetic can be objective only with an explicit calculation and matching quotation',async()=>{
  const {p}=await scopedFixture();
  const f=row({type:'objective_error',message:'The request exceeds 4 × 875 = 3500 by 100; check downstream totals.',evidence:[{itemId:'E1',quote:'4 units at $875 each. Requested $3,600.'}],calculation:'4 × 875 = 3500; 3600 - 3500 = 100.',nextAction:'Correct the extension and recheck dependent totals.'});
  const r=verifyReport(p,scopedReport(p,[f]));
  assert.equal(r.findings[0].id,`${p.reportId}/F1`);
  assert.equal(r.findings[0].calculation,f.calculation);
  assert.throws(()=>verifyReport(p,scopedReport(p,[{...f,calculation:''}])),/explicit calculation/);
  assert.throws(()=>verifyReport(p,scopedReport(p,[{...f,evidence:[{itemId:'E1',quote:'Invented units 7'}]}])),/quotation/);
});
test('T02 fully reviewed excerpts with clean math cannot erase missing guidance followups',async()=>{
  const {ctx,p,report}=await scopedFixture({requestedChecks:['calculations','compliance'],opportunity:''});
  assert.equal(p.requiredFollowups.length,2);
  assert.throws(()=>verifyReport(p,{...report,findings:[]}),/Required follow-up/);
  assert.throws(()=>verifyReport(p,{...report,findings:[report.findings[0]]}),/Required follow-up/);
  assert.equal(verifyReport(p,report).requiredFollowups.length,2);
  const altered=structuredClone(p); altered.requiredFollowups=[];
  await assert.rejects(verifyPacket(ctx,altered),/frozen round/);
});
test('T03 conflicting guidance remains a linked question and institutional sources may be cited',async()=>{
  const ctx=scopedRound({requestedChecks:['compliance'],guidanceStatus:'conflicting'});
  ctx.documents.push({id:id(),name:'Institution source',category:'Institutional guidance',requirement:'Required',source:'Fictional policy v2',version:{id:id()}});
  const p=await sealPacket(ctx,[{documentId:ctx.documents[0].id,anchor:'Budget!A1',text:'The request is 900.'},{documentId:ctx.documents[1].id,anchor:'Notice A section 2',text:'The base excludes travel.'},{documentId:ctx.documents[2].id,anchor:'Policy B section 3',text:'The base includes travel.'}]);
  const report=scopedReport(p);report.findings[0].guidance=[{itemId:'E2',quote:'The base excludes travel.'},{itemId:'E3',quote:'The base includes travel.'}];
  assert.equal(verifyReport(p,report).findings[0].type,'question');
  report.findings[0].type='objective_error';report.findings[0].evidence=[{itemId:'E1',quote:'request is 900'}];
  assert.throws(()=>verifyReport(p,report),/type\/identity/);
});
test('T04 saved caches and formula inspection keep independent/engine verification unchecked',async()=>{
  for(const method of ['not_checked','saved_values','formulas']) {
    const {p,report}=await scopedFixture({calculationEvidence:method,calculationNote:method==='not_checked'?'':'Only saved input and unresolved external link inspected.'});
    assert(p.requiredFollowups.some(g=>g.message.includes('recalculation')));
    assert.throws(()=>verifyReport(p,{...report,findings:[]}),/Required follow-up/);
  }
  assert.throws(()=>normalizeReviewContext(scope({calculationEvidence:'excel',calculationNote:''})),/missing/);
});
test('T05 unknown, incorrect and unreviewed citations are rejected; exact quotation is not semantic verification',async()=>{
  const {p}=await scopedFixture();
  for(const evidence of [[{itemId:'E99',quote:'4 units'}],[{itemId:'E1',quote:'Wrong quotation'}]]) assert.throws(()=>verifyReport(p,scopedReport(p,[row({evidence})])),/quotation/);
  assert.throws(()=>verifyReport(p,scopedReport(p,[row({guidance:[{itemId:'E1',quote:'4 units'}]})])),/guidance/);
  const r=scopedReport(p,[row({type:'coverage_gap',evidence:[{itemId:'E1',quote:'4 units'}]})]);r.coverage={reviewed:[],unreviewed:['E1']};
  assert.throws(()=>verifyReport(p,r),/reviewed excerpt/);
});
test('T06/T07 v2 scope, active versions, proposal identity and prior identities cannot cross rounds',async()=>{
  const {ctx,p,report}=await scopedFixture();
  for(const patch of [{proposalId:id()},{roundId:id()},{reviewContext:scope({scope:'Another review'})},{priorFindings:[{findingId:id()+'/F1',message:'Other proposal',type:'question',owner:'',nextAction:'',disposition:'Open'}]}]) await assert.rejects(verifyPacket({...ctx,...patch},p));
  const changed=structuredClone(ctx); changed.documents[0].version.id=id();await assert.rejects(verifyPacket(changed,p),/version/);
  for(const key of ['reviewerRelease','format','proposalId','roundId','packetId','reportId','digest']) assert.throws(()=>verifyReport(p,{...report,[key]:id()}));
  assert.throws(()=>verifyReport(p,scopedReport(p,[row({priorFindingId:id()+'/F1'})])),/foreign/);
});
test('T08 an unresolved issue must be returned exactly once with its original stable identity',async()=>{
  const ctx=scopedRound({purpose:'revision'});
  const priorId=id()+'/F1';ctx.priorFindings=[{findingId:priorId,message:'Vendor quote is absent.',type:'coverage_gap',owner:'Administrator',nextAction:'Obtain the matching quote.',disposition:'Deferred'}];
  const p=await sealPacket(ctx,[{documentId:ctx.documents[0].id,anchor:'Budget!A1',text:'Revised budget. Quote pending.'}]);
  const r=scopedReport(p); assert.equal(verifyReport(p,r).findings[0].id,priorId);
  assert.throws(()=>verifyReport(p,{...r,findings:[]}),/Required follow-up/);
  assert.throws(()=>verifyReport(p,{...r,findings:[...r.findings,...r.findings]}),/duplicated/);
  assert.throws(()=>verifyReport(p,{...r,findings:[{...r.findings[0],priorFindingId:null}]}),/identity/);
  r.findings[0].type='coverage_gap'; assert.equal(verifyReport(p,r).findings[0].id,priorId);
});
test('full package inventory includes missing requirements and validation while drafting avoids an unsolicited compliance check',async()=>{
  const ctx=scopedRound({lane:'package',requestedChecks:['completeness']});
  ctx.documents.push({id:id(),name:'Facilities',category:'Facilities',requirement:'Required',source:'Call A §3',version:null},{id:id(),name:'Conditional plan',category:'Other attachment',requirement:'Applicability unknown',source:'',version:null});
  const p=await sealPacket(ctx,[{documentId:ctx.documents[0].id,anchor:'Budget!A1',text:'100 units.'}]);
  assert.equal(p.inventory.length,4);assert.equal(p.requiredFollowups.length,4);
  assert(p.requiredFollowups.some(g=>g.message.includes('validation')));
  assert(p.requiredFollowups.some(g=>g.documentId===ctx.documents[2].id));
  const draft=await scopedFixture({purpose:'drafting',requestedChecks:['narrative'],narrativePermission:'comments_only'});
  assert.equal(draft.p.requiredFollowups.length,0);
  assert.throws(()=>normalizeReviewContext(scope({requestedChecks:['narrative']})),/narrative feedback/);
});
test('legacy imports remain valid but unscoped rounds cannot export or scoped rounds downgrade',async()=>{
  const {ctx,p}=await fixture();await assert.rejects(sealPacket(ctx,[]),/new round/);
  await assert.rejects(verifyPacket({...ctx,reviewContext:scope()},p),/downgraded/);
  assert.equal((await verifyPacket(ctx,p)).reviewerRelease,'0.1.0');
});
test('v2 digest covers all context and allows harmless object property reordering',async()=>{
  const {ctx,p}=await scopedFixture();
  const reordered=structuredClone(p);reordered.reviewContext=Object.fromEntries(Object.entries(p.reviewContext).reverse());
  assert.deepEqual(await verifyPacket(ctx,reordered),p);
  for(const key of ['scope','owner','opportunity']) {const changed=structuredClone(p);changed.reviewContext[key]+=' altered';await assert.rejects(verifyPacket(ctx,changed));}
  const bad=structuredClone(p);bad.inventory[0].source='Another authority';await assert.rejects(verifyPacket(ctx,bad));
});
test('known guidance conflicts survive a focused policy round without a compliance checkbox',async()=>{
  const {p,report}=await scopedFixture({purpose:'policy',requestedChecks:['consistency'],guidanceStatus:'conflicting'});
  assert.equal(p.requiredFollowups.length,1);
  assert.equal(p.requiredFollowups[0].type,'question');
  assert.throws(()=>verifyReport(p,{...report,findings:[]}),/Required follow-up/);
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sealPacket,sealPacketSet,packetRegistration,verifyPacket,verifyReport,RELEASE} from './packet.js';
import {normalizeChecklist} from './checklist.js';
import {normalizeReviewContext} from './review-context.js';

const id=()=>crypto.randomUUID();
function scope(patch={}) { return {lane:'focused',purpose:'initial',opportunity:'Fictional call 2026, edition A',
  scope:'Inspect supplied formulas and compare the figures within the selected evidence.',requestedChecks:['calculations'],
  guidanceStatus:'provided',owner:'Lynn',nextAction:'Check supported figures',calculationEvidence:'formulas',
  calculationNote:'Formula inspection only; no engine run or link refresh.',narrativePermission:'not_requested',handling:'real_proposal',...patch}; }
function document(category='Budget',patch={}) { return {id:id(),name:'Fictional '+category,category,requirement:'Required',
  source:'Supplied edition',version:{id:id(),sha256:'a'.repeat(64)},...patch}; }
function checkRow(documents,patch={}) { return {checkId:id(),label:'Inspect the arithmetic',applicability:'required',
  basis:'Requested formula inspection',sourceDocumentIds:[],documentIds:documents.map(d=>d.id),owner:'Lynn',nextAction:'Check the figures',...patch}; }
function context() {
  const documents=[document()];
  return {workflowVersion:3,proposalId:id(),roundId:id(),packets:[],reviewContext:scope(),priorFindings:[],documents,
    checklist:[checkRow(documents)],heldCheckIds:[],wholeReviewHeld:false};
}
function excerpt(doc,patch={}) { return {documentId:doc.id,versionId:doc.version.id,anchor:'Budget!B4:B8',
  text:'B4 700; B5 200; B6 150; B7 memo 25 excluded; B8 formula SUM(B4:B6); saved cache 900.',
  provenance:{method:'extracted',note:'Formula and stored value read locally; no recalculation.'},...patch}; }
function finding(patch={}) { return {type:'question',message:'Confirm the supplied evidence.',evidence:[],guidance:[],gapIds:[],
  priorFindingId:null,owner:'Lynn',nextAction:'Inspect the active file.',calculation:'',...patch}; }
function report(packet,patch={}) {
  const keys=['reviewerRelease','proposalId','roundId','packetId','reportId','digest','packetSetId','batchId','batchIndex','batchCount','manifestDigest'];
  return {format:'juliet.findings.v3',...Object.fromEntries(keys.map(key=>[key,packet[key]])),
    coverage:{reviewed:packet.items.map(i=>i.itemId),unreviewed:[]},
    findings:packet.requiredFollowups.map(g=>finding({type:g.type,message:g.message,gapIds:[g.id],priorFindingId:g.priorFindingId,nextAction:g.nextAction})),
    checkResults:packet.assignedCheckIds.map(checkId=>({checkId,status:'checked',message:'Formula inputs inspected; recalculation was not performed.',
      evidence:[{itemId:'E1',quote:'B4 700'}],guidance:[],findingRefs:[]})),...patch};
}
async function fixture() {
  const ctx=context();const packets=await sealPacketSet(ctx,[excerpt(ctx.documents[0])]);ctx.packets=packets.map(packetRegistration);
  return {ctx,packets,p:packets[0],r:report(packets[0])};
}

test('v3 supports approved real evidence, formula inspection, manual attribution and canonical readback',async()=>{
  const {ctx,p,r}=await fixture();
  assert.equal(p.reviewerRelease,RELEASE);assert.equal(RELEASE,'1.0.0');
  assert.equal(p.material,'approved-proposal-evidence');assert.equal(p.requiredFollowups.length,0);
  const reordered=JSON.parse(JSON.stringify(p,(key,value)=>value && !Array.isArray(value) && typeof value==='object'?Object.fromEntries(Object.entries(value).reverse()):value));
  assert.deepEqual(await verifyPacket(ctx,reordered),p);
  const result=verifyReport(p,r);assert.equal(result.checkResults[0].status,'checked');
  assert.deepEqual(result.evidenceProvenance,[{itemId:'E1',...p.items[0].provenance}]);
  const [manual]=await sealPacketSet(ctx,[excerpt(ctx.documents[0],{provenance:{method:'manual',note:'Lynn inspected the unsupported source locally.'}})]);
  assert.equal(manual.evidenceCoverage[0].methods[0],'manual');
  await assert.rejects(sealPacketSet(ctx,[excerpt(ctx.documents[0],{provenance:{method:'manual',note:''}})]),/attribution/);
});

test('v3 blocks drafting scope, preserves cited process suggestions and rejects malformed checklist definitions',async()=>{
  const {ctx,p,r}=await fixture();
  for(const reviewContext of [scope({purpose:'drafting'}),scope({narrativePermission:'suggested_edits'})]) {
    await assert.rejects(sealPacketSet({...ctx,reviewContext},[excerpt(ctx.documents[0])]));
  }
  assert.equal(normalizeReviewContext(scope({purpose:'drafting'})).purpose,'drafting','Historical normalization remains available.');
  assert.equal(verifyReport(p,{...r,findings:[finding({type:'suggestion',message:'Record a separate local inspection of the active formula before routing.',evidence:[{itemId:'E1',quote:'B4 700'}]})]}).findings[0].type,'suggestion');
  for(const changes of [{checkId:id(),documentIds:[id()]},{sourceDocumentIds:[ctx.documents[0].id]},{applicability:'not_applicable',basis:''}]) {
    assert.throws(()=>normalizeChecklist([{...ctx.checklist[0],...changes}],ctx.documents));
  }
  assert.throws(()=>normalizeChecklist([ctx.checklist[0],ctx.checklist[0]],ctx.documents),/duplicated/);
});

test('v3 single-location arithmetic keeps supported calculation and binds shared finding links',async()=>{
  const ctx=context();ctx.checklist.push(checkRow(ctx.documents,{label:'Reconcile dependent total'}));
  const [p]=await sealPacketSet(ctx,[excerpt(ctx.documents[0])]);
  const f=finding({type:'objective_error',message:'The saved result is 150 below the supplied formula inputs. No engine run was performed.',
    evidence:[{itemId:'E1',quote:'B4 700; B5 200; B6 150'}],calculation:'700 + 200 + 150 = 1050; 1050 - 900 = 150. Memo 25 is outside B4:B6.'});
  const r=report(p,{findings:[f]});r.checkResults.forEach(row=>row.findingRefs=['F1']);
  const result=verifyReport(p,r);
  assert.equal(result.findings.length,1);
  assert(result.checkResults.every(row=>row.findingIds[0]===result.findings[0].id));
  assert.throws(()=>verifyReport(p,{...r,findings:[{...f,calculation:''}]}),/explicit calculation/);
});

test('v3 rejects missing, duplicate and foreign check results, unsupported checked claims and forged citations',async()=>{
  const {p,r}=await fixture();const row=r.checkResults[0];
  for(const checkResults of [[],[row,row],[{...row,checkId:id()}],[{...row,evidence:[]}],
    [{...row,evidence:[{itemId:'E1',quote:'Recalculated value 1050'}]}],
    [{...row,findingRefs:['F1']}],[{...row,status:'not_applicable'}]]) assert.throws(()=>verifyReport(p,{...r,checkResults}));
  assert.throws(()=>verifyReport(p,{...r,coverage:{reviewed:[],unreviewed:['E1']},findings:[finding({type:'coverage_gap'})]}),/unreviewed/);
});

test('v3 missing evidence needs no invented excerpt and every incomplete check links a persisted gap',async()=>{
  const ctx=context();ctx.documents[0].version=null;
  const [p]=await sealPacketSet(ctx,[]);ctx.packets=[packetRegistration(p)];
  assert.equal(p.items.length,0);assert.equal(p.evidenceCoverage[0].status,'not_supplied');
  const r=report(p);r.checkResults[0]={...r.checkResults[0],status:'missing',message:'The required budget is absent.',evidence:[],findingRefs:['F1']};
  assert.equal((await verifyPacket(ctx,p)).items.length,0);
  assert.equal(verifyReport(p,r).checkResults[0].status,'missing');
  assert.throws(()=>verifyReport(p,{...r,findings:[]}),/Required follow-up/);
  assert.throws(()=>verifyReport(p,{...r,checkResults:[{...r.checkResults[0],findingRefs:[]}]}),/incomplete checklist/);
});

test('v3 batches retain complete cross-document dependencies and unique check assignments',async()=>{
  const ctx=context();ctx.documents=Array.from({length:3},()=>document());
  ctx.checklist=[checkRow(ctx.documents.slice(0,2),{label:'Reconcile two sources'}),checkRow(ctx.documents.slice(2),{label:'Inspect separate attachment'})];
  const evidence=ctx.documents.flatMap(doc=>Array.from({length:11},(_,i)=>excerpt(doc,{anchor:'Range '+i,text:'x'.repeat(1000)})));
  const packets=await sealPacketSet(ctx,evidence);ctx.packets=packets.map(packetRegistration);
  assert.equal(packets.length,2);assert.equal(packets[0].items.length,22);assert.equal(packets[1].items.length,11);
  assert.deepEqual(packets.map(p=>p.assignedCheckIds),ctx.checklist.map(c=>[c.checkId]));
  assert.deepEqual(packets[0].requiredFollowups,[],'Unrelated third document is not reported as missing in the first batch.');
  for(const p of packets) await verifyPacket(ctx,p);
  await assert.rejects(sealPacket(ctx,evidence),/multiple batches/);
  await assert.rejects(verifyPacket({...ctx,packets:ctx.packets.slice(0,1)},packets[0]),/completely registered/);
  const r=report(packets[0]);assert.throws(()=>verifyReport(packets[0],{...r,batchId:packets[1].batchId}),/packet set and batch/);
  const tooMany=Array.from({length:31},(_,i)=>excerpt(ctx.documents[0],{anchor:'A'+i}));
  await assert.rejects(sealPacketSet(ctx,tooMany),/One check exceeds/);
});

test('v3 enforces bounds before export and preserves scoped missing or conflicting guidance',async()=>{
  const ctx=context();const guide=document('Opportunity guidance');ctx.documents.push(guide);ctx.checklist[0].sourceDocumentIds=[guide.id];
  const evidence=[excerpt(ctx.documents[0]),excerpt(guide,{anchor:'Section 2',text:'Use the supplied base.'})];
  for(const guidanceStatus of ['missing','conflicting']) {
    const [p]=await sealPacketSet({...ctx,reviewContext:scope({guidanceStatus,requestedChecks:['compliance']})},evidence);
    const r=report(p);r.checkResults[0].guidance=[{itemId:'E2',quote:'Use the supplied base.'}];
    assert(p.requiredFollowups.length>0);
    assert.throws(()=>verifyReport(p,r),/Missing or conflicting guidance/);
    r.checkResults[0].status='decision_needed';r.checkResults[0].findingRefs=['F1'];
    assert.equal(verifyReport(p,r).checkResults[0].status,'decision_needed');
  }
  await assert.rejects(sealPacketSet(ctx,[excerpt(ctx.documents[0],{text:'x'.repeat(6001)})]),/6,000/);
  await assert.rejects(sealPacketSet(ctx,Array.from({length:11},(_,i)=>excerpt(ctx.documents[0],{anchor:'A'+i,text:'x'.repeat(6000)}))),/One check exceeds/);
});

test('v3 whole holds block sealing and scoped holds remain frozen after clearance',async()=>{
  const ctx=context();const evidence=[excerpt(ctx.documents[0])];
  await assert.rejects(sealPacketSet({...ctx,wholeReviewHeld:true},evidence),/whole review on hold/);
  ctx.heldCheckIds=[ctx.checklist[0].checkId];const [p]=await sealPacketSet(ctx,evidence);ctx.packets=[packetRegistration(p)];
  const r=report(p);assert.throws(()=>verifyReport(p,r),/held check/);
  r.findings.push(finding({type:'coverage_gap',message:'Lynn has held the affected check.'}));
  r.checkResults[0]={...r.checkResults[0],status:'unchecked',findingRefs:['F1']};
  assert.equal(verifyReport(p,r).checkResults[0].status,'unchecked');
  assert.equal((await verifyPacket({...ctx,heldCheckIds:[]},p)).heldCheckIds.length,1,'A later clearance does not rewrite the frozen packet.');
});

test('v3 two similar proposals cannot mix identities, document versions, manifests or retained findings',async()=>{
  const {ctx,p,r}=await fixture();const foreign=context();
  for(const changed of [{proposalId:foreign.proposalId},{roundId:foreign.roundId},{documents:foreign.documents},
    {checklist:[{...ctx.checklist[0],label:'Other check'}]}]) await assert.rejects(verifyPacket({...ctx,...changed},p));
  for(const key of ['proposalId','roundId','packetId','packetSetId','batchId','reportId','manifestDigest','digest']) assert.throws(()=>verifyReport(p,{...r,[key]:id()}));
  for(const key of ['manifestDigest','packetSetId']) await assert.rejects(verifyPacket(ctx,{...p,[key]:id()}));
  const changed=structuredClone(p);changed.items[0].provenance={method:'manual',note:'A different human record'};
  await assert.rejects(verifyPacket(ctx,changed),/manifest/);
  const priorId=id()+'/F1';ctx.priorFindings=[{findingId:priorId,message:'Check the corrected formula.',type:'objective_error',owner:'Lynn',nextAction:'Inspect active evidence.',disposition:'Needs recheck'}];
  const [revised]=await sealPacketSet(ctx,[excerpt(ctx.documents[0])]);const rr=report(revised);
  assert.equal(verifyReport(revised,rr).findings[0].id,priorId);
  assert.throws(()=>verifyReport(revised,{...rr,findings:[{...rr.findings[0],priorFindingId:foreign.roundId+'/F1'}]}),/foreign/);
});

test('v3 approved full-package example links missing partner letter and validation to one finding',async()=>{
  const ctx=context();ctx.documents=[document('Narrative'),document('Budget'),document('Budget justification'),document('Subaward',{version:null}),document('Validation report')];
  ctx.checklist=[checkRow([ctx.documents[3]],{label:'Required partner letter'}),checkRow([ctx.documents[4]],{label:'Validation identifies the missing partner letter'})];
  const [p]=await sealPacketSet(ctx,[excerpt(ctx.documents[4],{anchor:'Validation line 3',text:'Error: required partner letter is missing.'}),...ctx.documents.slice(0,3).map(doc=>excerpt(doc))]);
  const r=report(p);r.findings[0].evidence=[{itemId:'E1',quote:'required partner letter is missing'}];
  r.checkResults=[{checkId:ctx.checklist[0].checkId,status:'missing',message:'Required partner letter is absent.',evidence:[],guidance:[],findingRefs:['F1']},
    {checkId:ctx.checklist[1].checkId,status:'checked',message:'The validation error refers to the same absent letter.',evidence:[{itemId:'E1',quote:'required partner letter is missing'}],guidance:[],findingRefs:['F1']}];
  const normalized=verifyReport(p,r);assert.equal(normalized.findings.length,1);
  assert.equal(normalized.checkResults[0].findingIds[0],normalized.checkResults[1].findingIds[0]);
});

test('v3 source limitations remain frozen separately from selected-excerpt coverage and cannot disappear from findings',async()=>{
  const ctx=context();Object.assign(ctx.documents[0].version,{coverage:'partial',limitations:[{
    location:'Workbook externalLink1',feature:'external workbook link',message:'Dependent values cannot be independently evaluated without the linked source.'
  }]});
  const [p]=await sealPacketSet(ctx,[excerpt(ctx.documents[0],{provenance:{method:'manual',note:'Lynn inspected the visible formula references locally.'}})]);
  ctx.packets=[packetRegistration(p)];
  assert.equal(p.inventory[0].coverage,'partial');assert.equal(p.evidenceCoverage[0].status,'provided');
  assert.equal(p.inventory[0].limitations[0].feature,'external workbook link');
  assert.equal(p.requiredFollowups[0].type,'coverage_gap');
  const r=report(p);assert.equal(verifyReport(p,r).findings.length,1);
  assert.throws(()=>verifyReport(p,{...r,findings:[]}),/Required follow-up/);
  const changed=structuredClone(p);changed.inventory[0].limitations=[];
  await assert.rejects(verifyPacket(ctx,changed),/frozen round/);
  assert.equal((await verifyPacket(ctx,p)).inventory[0].sha256,ctx.documents[0].version.sha256);
});

test('v3 set-wide guidance presence prevents false missing-source gaps in an independent arithmetic batch',async()=>{
  const ctx=context();ctx.documents=[document(),document('Budget justification'),document('Opportunity guidance')];
  ctx.reviewContext=scope({requestedChecks:['calculations','compliance']});
  ctx.checklist=[checkRow([ctx.documents[0]]),checkRow([ctx.documents[1]],{label:'Compare the supplied limit',sourceDocumentIds:[ctx.documents[2].id]})];
  const evidence=[...Array.from({length:30},(_,i)=>excerpt(ctx.documents[0],{anchor:'A'+i,text:'Value '+i})),
    excerpt(ctx.documents[1],{anchor:'Paragraph 1',text:'Requested total 100.'}),excerpt(ctx.documents[2],{anchor:'Section 2',text:'Maximum total 200.'})];
  const packets=await sealPacketSet(ctx,evidence);assert.equal(packets.length,2);
  assert.deepEqual(packets.map(p=>p.requiredFollowups),[[],[]]);
  ctx.packets=packets.map(packetRegistration);for(const p of packets) await verifyPacket(ctx,p);
  const missing=document('Personnel',{version:null});ctx.documents.push(missing);
  const changed=await sealPacketSet(ctx,evidence);
  assert(changed[0].requiredFollowups.some(g=>g.documentId===missing.id),'Required inventory omissions survive even when the checklist has no corresponding check yet.');
});

test('v3 freezes derivative provenance separately from its extracted evidence and retains the original source identity',async()=>{
  const ctx=context();const original=id();
  Object.assign(ctx.documents[0].version,{provenance:'derivative',sourceVersionId:original});
  const [p]=await sealPacketSet(ctx,[excerpt(ctx.documents[0])]);ctx.packets=[packetRegistration(p)];
  assert.equal(p.inventory[0].provenance,'derivative');assert.equal(p.inventory[0].sourceVersionId,original);
  assert.equal(p.items[0].provenance.method,'extracted','Extracted describes the derivative read, not original-file equivalence.');
  assert.equal((await verifyPacket(ctx,p)).inventory[0].sourceVersionId,original);
  const changed=structuredClone(p);changed.inventory[0].provenance='original';changed.inventory[0].sourceVersionId=null;
  await assert.rejects(verifyPacket(ctx,changed),/frozen round/);
  delete ctx.documents[0].version.sourceVersionId;
  await assert.rejects(sealPacketSet(ctx,[excerpt(ctx.documents[0])]),/original registered source/);
});

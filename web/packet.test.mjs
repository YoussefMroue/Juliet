import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sealPacket, verifyPacket, verifyReport} from './packet.js';

const id = () => crypto.randomUUID();
function round() {
  return {proposalId:id(), roundId:id(), packets:[], documents:['Budget','Opportunity guidance'].map(category =>
    ({id:id(), category, version:{id:id()}}))};
}
async function fixture() {
  const ctx = round();
  const p = await sealPacket(ctx, [
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
  const copies = await sealPacket(ctx,['Budget!B1','budget!b1'].map(anchor =>
    ({documentId:ctx.documents[0].id,anchor,text:'One year total 1100.'})));
  const duplicated = {...report,packetId:copies.packetId,reportId:copies.reportId,digest:copies.digest,
    findings:[{...guidanceAsEvidence,evidence:['E1','E2'].map(itemId=>({itemId,quote:'total 1100'}))}]};
  assert.throws(()=>verifyReport(copies,duplicated), /two distinct proposal locations/);
  assert.equal(verifyReport(p,report).locations[1].anchor,'Fictional guide v1, section 2');
});

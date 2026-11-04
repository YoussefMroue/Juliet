import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectLocalFile, sourceDigest} from './intake.js';
const bytes = new Uint8Array([1,2,3,4]);
const file = (name='source.xlsx') => ({name,size:bytes.byteLength,arrayBuffer:async()=>bytes.slice().buffer});

test('local Office evidence is bound to source bytes and reader arguments', async()=>{
  const digest=await sourceDigest(bytes);
  let called=0;
  const actual=await inspectLocalFile(file(),{readOffice:async(data,kind)=>{
    called++; assert.deepEqual(data,bytes);assert.equal(kind,'xlsx');
    return JSON.stringify({sha256:digest,size:4,coverage:'partial',limitations:[],items:[{anchor:'Budget!B8',text:'Formula: =SUM(B4:B6)\nSaved cached value: 900',method:'extracted'}]});
  }});
  assert.equal(called,1);assert.equal(actual.sha256,digest);assert.equal(actual.size,4);
  assert.equal(actual.items[0].method,'extracted');assert.deepEqual(bytes,new Uint8Array([1,2,3,4]));
});

test('unsupported source keeps a hash-bound manual fallback with no extracted claims', async()=>{
  const actual=await inspectLocalFile(file('legacy.xls'));
  assert.equal(actual.coverage,'blocked');assert.equal(actual.items.length,0);
  assert.equal(actual.sha256,await sourceDigest(bytes));
  assert.match(actual.limitations[0].message,/supported derivative|manual|human inspection/);
});

test('mismatched reader identity is blocked rather than attributed to the selected file', async()=>{
  const actual=await inspectLocalFile(file(),{readOffice:async()=>({sha256:'0'.repeat(64),size:4,items:[{text:'wrong'}],limitations:[]})});
  assert.equal(actual.coverage,'blocked');assert.equal(actual.items.length,0);
  assert.match(actual.limitations[0].message,/match the selected source/);
});

test('strict PDF failure remains visible and does not weaken original preparation rules', async()=>{
  const actual=await inspectLocalFile(file('narrative.pdf'),{readPdf:()=>{throw Error('Page 2: custom font requires local inspection.');}});
  assert.equal(actual.coverage,'blocked');assert.deepEqual(actual.items,[]);
  assert.match(actual.limitations[0].message,/Page 2: custom font/);
});

test('supported PDF lines receive original page and line anchors', async()=>{
  const actual=await inspectLocalFile(file('narrative.pdf'),{readPdf:()=>[[{value:'Narrative first page'}],[{value:'Page two line one'},{value:'Page two line two'}]]});
  assert.equal(actual.items[2].anchor,'Page 2 · line 2');
  assert.equal(actual.items[2].text,'Page two line two');
  assert.equal(actual.coverage,'partial');
});

test('size and changed-source guards stop processing before evidence claims', async()=>{
  let opened=false;
  await assert.rejects(()=>inspectLocalFile({name:'large.xlsx',size:64*1024*1024+1,arrayBuffer:async()=>{opened=true;return bytes.buffer;}}),/64 MiB/);
  assert.equal(opened,false);
  await assert.rejects(()=>inspectLocalFile({...file(),size:5}),/source changed/);
});

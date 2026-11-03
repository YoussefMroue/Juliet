// Build the site before running this test so the deployed MuPDF runtime is used.
import assert from 'node:assert/strict';
import test from 'node:test';
import {PDFDocument, PDFName, StandardFonts, rgb} from 'pdf-lib';
import {readPdf} from '../dist/site/pdf.js';

async function fixture(draw) {
  const doc=await PDFDocument.create();
  const page=doc.addPage([400,250]);
  const font=await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Personnel ID:',{font,x:20,y:200});
  draw(page);
  return doc.save();
}

test('a selectable page with a single solid divider is supported', async()=>{
  const bytes=await fixture(page=>page.drawLine({start:{x:20,y:180},end:{x:380,y:180},thickness:1}));
  assert.equal(readPdf(bytes)[0][0].value,'Personnel ID:');
});

test('rectangular strokes forming a non-selectable ID block the entire PDF', async()=>{
  const bytes=await fixture(page=>{
    for(const x of [20,55,90,125]){
      page.drawRectangle({x,y:140,width:22,height:5,color:rgb(0,0,0)});
      page.drawRectangle({x:x+17,y:110,width:5,height:35,color:rgb(0,0,0)});
    }
  });
  assert.throws(()=>readPdf(bytes),/drawing/);
});

test('unfilled strokes forming a non-selectable ID are blocked too', async()=>{
  const bytes=await fixture(page=>{
    for(const x of [20,55,90,125])
      page.drawLine({start:{x,y:140},end:{x,y:110},thickness:1});
  });
  assert.throws(()=>readPdf(bytes),/drawing/);
});

test('custom font mappings cannot contradict the rendered glyph', async()=>{
  const doc=await PDFDocument.load(await fixture(()=>{}));
  const fonts=doc.getPage(0).node.Resources().lookup(PDFName.of('Font'));
  const font=fonts.lookup(fonts.keys()[0]);
  font.set(PDFName.of('Encoding'),doc.context.obj({Type:'Encoding',Differences:[65,'seven']}));
  const bytes=await doc.save();
  assert.throws(()=>readPdf(bytes),/font|encoding/i);
});

test('a text ID alongside a second copy drawn in standard-font symbols is blocked', async()=>{
  const doc=await PDFDocument.create();
  const page=doc.addPage([400,250]);
  const font=await doc.embedFont(StandardFonts.Courier);
  page.drawText('Personnel ID: 7777',{font,x:20,y:200});
  const rows=['##### ##### ##### #####','    #     #     #     #','   #     #     #     #','  #     #     #     #'];
  rows.forEach((row,i)=>page.drawText(row,{font,size:10,x:20,y:160-10*i}));
  const bytes=await doc.save();
  assert.throws(()=>readPdf(bytes),/text artwork/);
});

// All processing uses in-tab WebAssembly and memory buffers.
import mupdf from './mupdf/mupdf.js';

const fail = (message) => { throw new Error(message); };
const compact = text => text.replace(/\s/gu, '');
const inventory = text => Array.from(compact(text)).sort().join('');
function textLines(page) {
  const lines = [];
  const text = page.toStructuredText('');
  try {
    text.walk({
      beginLine(box, mode, dir) {
        if (mode || Math.abs(dir[0]-1)>.001 || Math.abs(dir[1])>.001) fail('Rotated PDF text requires source cleanup.');
        lines.push({value:'', chars:[]});
      },
      onChar(c, origin, font, size, quad) {
        if ([...c].length!==1 || c==='\uFFFD') fail('PDF text could not be mapped to individual characters.');
        const line=lines.at(-1);
        line.value+=c;
        line.chars.push({c,origin,size,quad});
      }
    });
  } finally { text.destroy(); }
  return lines.filter(l=>l.value.trim());
}

function checkContent(page) {
  let unsafe=false;
  const reject=()=>{unsafe=true;};
  function path(shape, _, matrix) {
    if(matrix[1] || matrix[2]) unsafe=true;
    let last,first;
    function segment(x,y) { if(last && last[0]!==x && last[1]!==y) unsafe=true; last=[x,y]; }
    shape.walk({moveTo(x,y){first=last=[x,y];}, lineTo:segment, curveTo:reject, closePath(){if(first)segment(...first);}});
  }
  const device=new mupdf.Device({fillPath:path,strokePath:path,fillImage:reject,fillImageMask:reject,
    clipImageMask:reject,fillShade:reject,ignoreText:reject,strokeText:reject,clipText:reject,clipStrokeText:reject,
    beginLayer:reject,beginMask:reject,beginTile(){reject();return 0;}});
  try {page.runPageContents(device,mupdf.Matrix.identity);device.close();} finally {device.destroy();}
  if(unsafe) fail('PDF contains a scan, drawing, hidden text or other unsupported page content.');
}

export function readPdf(bytes) {
  const doc=new mupdf.PDFDocument(bytes);
  try {
    const trailer=doc.getTrailer(), root=trailer.get('Root');
    if(doc.needsPassword() || !trailer.get('Encrypt').isNull() || ['AcroForm','OCProperties','Collection'].some(k=>!root.get(k).isNull()) || !root.get('Names','EmbeddedFiles').isNull()) fail('Encrypted, layered, attached or interactive PDF.');
    if(!doc.countPages() || doc.countPages()>50) fail('Select a PDF with 1–50 pages.');
    const result=[];
    let pixels=0;
    for(let i=0;i<doc.countPages();i++){
      const p=doc.loadPage(i);
      try {
        const [x,y,w,h]=p.getBounds();
        pixels+=w*h*4;
        if(x||y||w>1440||h>1440||pixels>64000000||p.getObject().getInheritable('Rotate').asNumber()||p.getObject().get('Annots').length||!p.getObject().getInheritable('Resources').get('XObject').isNull()) fail('Unsupported crop, rotation, page size, annotation or embedded object.');
        checkContent(p);
        const lines=textLines(p);
        if(!lines.length) fail('No selectable text on this page.');
        result.push(lines);
      } catch(e){throw new Error('Page '+(i+1)+': '+e.message);} finally{p.destroy();}
    }
    return result;
  } finally{doc.destroy();}
}

export async function redactPdf(bytes, pages, editsByPage, verify) {
  const {PDFDocument,StandardFonts}=globalThis.PDFLib;
  const doc=new mupdf.PDFDocument(bytes);
  const out=await PDFDocument.create();
  const font=await out.embedFont(StandardFonts.Helvetica);
  const changes=[], previews=[], expected=[];
  try {
    for(const [i,lines] of pages.entries()){
      const page=doc.loadPage(i);
      try {
        const [, ,width,height]=page.getBounds();
        const target=out.addPage([width,height]), labels=[], kept=[];
        for(const [j,line] of lines.entries()){
          let start=0,after='',remaining='';
          for(const [a,b,label] of editsByPage[i][j]){
            const chars=line.chars.slice(a,b), quad=chars.flatMap(ch=>ch.quad);
            const xs=quad.filter((_,k)=>k%2===0), ys=quad.filter((_,k)=>k%2===1);
            const box=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
            if(!/^[\x20-\x7e]+$/.test(label)) fail('Use a plain-text PDF replacement.');
            const size=Math.min(chars[0].size, (box[2]-box[0])/font.widthOfTextAtSize(label,1));
            if(size<4) fail('Use a shorter replacement on page '+(i+1)+'.');
            const annot=page.createAnnotation('Redact');
            annot.setRect(box);annot.update();
            labels.push({text:label,x:box[0],y:height-chars[0].origin[1],size});
            const prefix=line.chars.slice(start,a).map(c=>c.c).join('');
            remaining+=prefix;after+=prefix+label;start=b;
          }
          const suffix=line.chars.slice(start).map(c=>c.c).join('');
          kept.push(remaining+suffix);after+=suffix;
          if(editsByPage[i][j].length) changes.push(['Justification','Page '+(i+1)+' · line '+(j+1),line.value,after]);
        }
        if(labels.length) page.applyRedactions(false,1,0,0);
        const clean=textLines(page);
        if(inventory(clean.map(l=>l.value).join(''))!==inventory(kept.join(''))) fail('Redaction would alter nearby text on page '+(i+1)+'.');
        const pix=page.toPixmap(mupdf.Matrix.scale(2,2),mupdf.ColorSpace.DeviceRGB,false,false);
        let img;
        try{img=await out.embedPng(pix.asPNG());}finally{pix.destroy();}
        target.drawImage(img,{x:0,y:0,width,height});
        // Keep the verified words searchable, without copying source resources or metadata.
        for(const line of clean){
          for(const word of line.value.matchAll(/\S+/gu)){
            const ch=line.chars[Array.from(line.value.slice(0,word.index)).length];
            target.drawText(word[0],{font,x:ch.origin[0],y:height-ch.origin[1],size:ch.size,opacity:0});
          }
        }
        for(const {text,...pos} of labels) target.drawText(text,{font,...pos});
        expected.push(inventory(kept.join('')+labels.map(v=>v.text).join('')));
      }finally{page.destroy();}
    }
    const data=await out.save();
    const saved=new mupdf.PDFDocument(data);
    try{
      for(let i=0;i<saved.countPages();i++){
        const p=saved.loadPage(i);
        try{
          const text=textLines(p).map(l=>l.value).join(' ');
          if(inventory(text)!==expected[i]) fail('Saved PDF text failed verification.');
          verify(text);
          const pix=p.toPixmap(mupdf.Matrix.identity,mupdf.ColorSpace.DeviceRGB,false,false);
          try{previews.push(new Blob([pix.asPNG()],{type:'image/png'}));}finally{pix.destroy();}
        }finally{p.destroy();}
      }
    }finally{saved.destroy();}
    return {data,changes,previews};
  }finally{doc.destroy();}
}

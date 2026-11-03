import { mkdir, copyFile, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
const site = 'dist/site';
await mkdir(site, {recursive:true});
const siteFiles=['index.html','app.js','case-ui.js','portfolio.js','packet.js','packet-ui.js','pdf.js','style.css','_headers'];
const manifest=new Set([...siteFiles,'runtime.json']);
for(const file of ['pyodide.mjs','pyodide.asm.mjs','pyodide.asm.wasm','pyodide-lock.json','python_stdlib.zip'])manifest.add('pyodide/'+file);
for(const file of ['mupdf.js','mupdf-wasm.js','mupdf-wasm.wasm'])manifest.add('mupdf/'+file);
manifest.add('pdf-lib/pdf-lib.min.js');
async function checkFolder(dir=''){
  for(const entry of await readdir(path.join(site,dir),{withFileTypes:true})){
    const name=path.posix.join(dir,entry.name);
    if(entry.isDirectory()) await checkFolder(name);
    else if(!entry.isFile() || !manifest.has(name)) throw Error('Unexpected file in site output: '+name);
  }
}
await checkFolder();
for (const name of siteFiles) await copyFile('web/'+name,site+'/'+name);
for (const [pkg, files] of Object.entries({
  pyodide:['pyodide.mjs','pyodide.asm.mjs','pyodide.asm.wasm','pyodide-lock.json','python_stdlib.zip'],
  mupdf:['dist/mupdf.js','dist/mupdf-wasm.js','dist/mupdf-wasm.wasm'],
  'pdf-lib':['dist/pdf-lib.min.js']
})) {
  await mkdir(site+'/'+pkg,{recursive:true});
  for (const name of files) await copyFile('node_modules/'+pkg+'/'+name,site+'/'+pkg+'/'+path.basename(name));
}
const modules={};
for(const name of ['__init__','office','pdf','case','lynn']) modules[name+'.py']=await readFile('proposal_review/'+name+'.py','utf8');
const kit={};
for(const name of ['01-intake','02-review-instructions','03-findings'])kit[name+'.md']=await readFile('review-kit/'+name+'.md','utf8');
await writeFile(site+'/runtime.json',JSON.stringify({modules,kit,bridge:await readFile('web/bridge.py','utf8')}));

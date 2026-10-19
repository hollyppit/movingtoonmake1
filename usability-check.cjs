const fs=require('fs'),path=require('path'),http=require('http'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
 const root=process.cwd(),out=path.join(root,'verification/usability');fs.mkdirSync(out,{recursive:true});
 const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://localhost').pathname;const file=path.resolve(root,'.'+(name==='/'?'/index.html':name));if(!file.startsWith(root+path.sep)){res.statusCode=403;return res.end();}try{res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':'text/html');res.end(fs.readFileSync(file));}catch{res.statusCode=404;res.end();}}).listen(18769,'127.0.0.1');
 let browser;const checks=[];
 try{
  browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:18769');
  await page.waitForFunction(()=>document.querySelector('#localSt').textContent.includes('저장됨'));
  assert(await page.isDisabled('#undoBtn'));assert(await page.isDisabled('#redoBtn'));
  const title=await page.inputValue('#title');await page.fill('#title','편의성 검증');await page.keyboard.press('Control+s');
  await page.waitForFunction(()=>document.querySelector('#localSt').textContent.includes('저장됨'));
  assert.equal(await page.evaluate(async()=>JSON.parse(await DB.get('kv','project')).title),'편의성 검증');checks.push('Ctrl+S saves while typing');
  await page.click('#undoBtn');assert.equal(await page.inputValue('#title'),title);assert(!(await page.isDisabled('#redoBtn')));
  await page.click('#redoBtn');assert.equal(await page.inputValue('#title'),'편의성 검증');checks.push('undo and redo buttons');
  await page.focus('#fileBtn');await page.keyboard.press('ArrowDown');assert.equal(await page.getAttribute('#fileBtn','aria-expanded'),'true');assert.equal(await page.evaluate(()=>document.activeElement.dataset.m),'new');
  await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.dataset.m),'png');await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.dataset.m),'new');
  await page.keyboard.press('Escape');assert.equal(await page.getAttribute('#fileBtn','aria-expanded'),'false');assert.equal(await page.evaluate(()=>document.activeElement.id),'fileBtn');checks.push('menu arrows, wrapping, End, Escape and focus');
  await page.focus('#fileBtn');await page.keyboard.press('Space');assert.equal(await page.getAttribute('#fileBtn','aria-expanded'),'true');await page.keyboard.press('Escape');checks.push('Space activates focused buttons');
  await page.click('#fileBtn');await page.click('#title');assert.equal(await page.getAttribute('#fileBtn','aria-expanded'),'false');
  await page.click('#fileBtn');await page.focus('#title');assert.equal(await page.getAttribute('#fileBtn','aria-expanded'),'false');checks.push('menu closes on outside click and focus');
  await page.evaluate(async()=>{const original=DB.put;DB.put=()=>Promise.reject(Error('test storage failure'));try{await persistProject(projJSON())}catch{}finally{DB.put=original}});
  assert((await page.textContent('#localSt')).includes('실패'));await page.keyboard.press('Control+s');await page.waitForFunction(()=>document.querySelector('#localSt').textContent.includes('저장됨'));checks.push('storage failure and retry status');
  await page.fill('#title','자동저장 검증');
  await page.waitForFunction(async()=>JSON.parse(await DB.get('kv','project')).title==='자동저장 검증');
  await page.waitForFunction(()=>document.querySelector('#localSt').textContent.includes('저장됨'));
  await page.fill('#title','편의성 검증');
  await page.waitForFunction(async()=>JSON.parse(await DB.get('kv','project')).title==='편의성 검증');checks.push('automatic save without shortcut');
  const pending = await page.evaluate(async()=>{
    clearTimeout(saveT);
    const original=DB.put;let finish;
    DB.put=()=>new Promise(resolve=>{finish=resolve});
    try {
      const job=persistProject(projJSON());
      const saving=document.querySelector('#localSt').textContent;
      save();clearTimeout(saveT);
      finish();await job;
      return {saving,after:document.querySelector('#localSt').textContent};
    } finally { DB.put=original;flushLocal(); }
  });
  assert(pending.saving.includes('저장 중'));assert(pending.after.includes('대기'));checks.push('older save completion preserves newer pending status');
  await page.waitForFunction(()=>document.querySelector('#localSt').textContent.includes('저장됨'));
  await page.focus('#fileBtn');await page.keyboard.press('ArrowUp');
  const downloaded=page.waitForEvent('download');await page.keyboard.press('Enter');const png=await downloaded;
  assert(png.suggestedFilename().endsWith('.png'));assert.equal(await page.getAttribute('#fileBtn','aria-expanded'),'false');assert.equal(await page.evaluate(()=>document.activeElement.id),'fileBtn');checks.push('Enter executes PNG export and returns focus');
  await page.reload();await page.waitForFunction(()=>document.querySelector('#localSt').textContent.includes('저장됨'));assert.equal(await page.inputValue('#title'),'편의성 검증');checks.push('reload restores saved edits');
  const layouts=[];for(const width of [1440,1024,390]){await page.setViewportSize({width,height:1000});await page.screenshot({path:path.join(out,'screen-'+width+'.png')});const result=await page.evaluate(()=>{const bar=document.querySelector('header.bar'),r=bar.getBoundingClientRect();return{width:innerWidth,headerBottom:r.bottom,overflow:document.documentElement.scrollWidth>innerWidth,controls:['localSt','undoBtn','redoBtn','fileBtn'].map(id=>{const b=document.getElementById(id).getBoundingClientRect();return{id,visible:b.width>0&&b.left>=0&&b.right<=innerWidth&&b.bottom<=r.bottom}})}});assert(result.controls.every(c=>c.visible),JSON.stringify(result));layouts.push(result)}checks.push('header controls fit desktop, tablet and mobile');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({checks,layouts,errors},null,2));console.log(JSON.stringify({checks,layouts,errors}));
 }finally{if(browser)await browser.close();server.close()}
})().catch(e=>{console.error(e);process.exitCode=1});

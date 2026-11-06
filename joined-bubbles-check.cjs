const fs=require('fs'),path=require('path'),http=require('http'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{const root=process.cwd(),out=path.join(root,'verification/joined-bubbles');fs.mkdirSync(out,{recursive:true});
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost'),f=path.resolve(root,'.'+(u.pathname==='/'?'/index.html':u.pathname));if(!f.startsWith(root+path.sep)){res.statusCode=403;return res.end();}try{res.setHeader('Content-Type',f.endsWith('.js')?'application/javascript':'text/html');res.end(fs.readFileSync(f));}catch{res.statusCode=404;res.end();}}).listen(18774,'127.0.0.1');let browser;
try{browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:18774');await page.waitForFunction(()=>document.querySelector('#localSt').textContent.includes('저장됨'));
await page.exposeFunction('saveJoinedFixture',(name,data)=>{assert(/^[a-z-]+\.png$/.test(name));fs.writeFileSync(path.join(out,name),Buffer.from(data.split(',')[1],'base64'));});
const report=await page.evaluate(async()=>{
P.aspect='custom';P.canvasSize=[400,500];applyAspect();const p=selPanel();p.overlays=[];const kinds=Object.keys(KINDS).filter(k=>k!=='caption'),results=[];
const fixture=document.createElement('canvas');fixture.width=1200;fixture.height=1500;const fg=fixture.getContext('2d');fg.fillStyle='#ddd';fg.fillRect(0,0,1200,1500);
for(let i=0;i<kinds.length;i++){
 const kind=kinds[i],a=newOverlay(kind,p),b=newOverlay(kind,p);Object.assign(a,{text:'첫 번째 대사',x:.5,y:.34,size:24,w:.5,start:0,anim:'none',tail:null});Object.assign(b,{text:'이어지는 대사',x:.5,y:.65,size:24,w:.5,start:1.5,anim:'none',tail:null});p.overlays=[a,b];linkBubbles(p,a,b);
 const c=await renderOverlaysCanvas(p.overlays),g=c.getContext('2d'),mid=g.getImageData(200,248,1,1).data;
 const before=document.createElement('canvas');before.width=W;before.height=H;drawOverlayList(before.getContext('2d'),p.overlays,.5);const absent=before.getContext('2d').getImageData(200,325,1,1).data[3]===0;
 fg.drawImage(c,(i%3)*400,Math.floor(i/3)*500);fg.fillStyle='#555';fg.font='18px sans-serif';fg.fillText(KINDS[kind],(i%3)*400+12,Math.floor(i/3)*500+28);
 results.push({kind,connected:mid[3]>200&&(kind==='narration'||mid[0]>230),lateBubbleHidden:absent,timings:[a.start,b.start]});
}
await saveJoinedFixture('all-shapes.png',fixture.toDataURL());
// Mixed kinds and three-way group joining; text and voice objects are not merged or discarded.
const a=newOverlay('rrect',p),b=newOverlay('shout',p),c=newOverlay('thought',p);[a,b,c].forEach((o,i)=>Object.assign(o,{text:['명심해라','실전이다','알겠어요'][i],size:24,x:.5,y:.22+i*.25,start:i,anim:'none',tail:null}));p.overlays=[a,b,c];a.voice={assetId:'voice-fixture',dur:1,vol:1};linkBubbles(p,a,b);linkBubbles(p,b,c);const mixed=bubbleBatches(p.overlays).length===1&&p.overlays.length===3&&a.voice.assetId==='voice-fixture';
const png=await renderOverlaysCanvas(p.overlays);await saveJoinedFixture('mixed-shapes.png',png.toDataURL());
const adjusted=printBubbleList(p.overlays,{[b.id]:{dx:.1,s:.8}});const print=document.createElement('canvas');print.width=W;print.height=H;drawOverlayList(print.getContext('2d'),adjusted,0,{all:true});await saveJoinedFixture('print-mixed.png',print.toDataURL());
const psdBlob=await exportCutPsd(p),psd=agPsd.readPsd(await psdBlob.arrayBuffer());const psdNames=psd.children.map(l=>l.name),editableText=psd.children.filter(l=>l.text).length;
selOv=b.id;setTab('text');scrubT=3;save();renderAll();return {results,mixed,psdNames,editableText};
});
for(const r of report.results){assert(r.connected,r.kind+' has connected fill');assert(r.lateBubbleHidden,r.kind+' respects timing');assert.deepEqual(r.timings,[0,1.5]);}assert(report.mixed);assert(report.psdNames.some(n=>n.includes('연결 말풍선')));assert(report.editableText>=3);
assert(await page.isVisible('#bubbleUnjoin'));await page.click('#bubbleUnjoin');assert.equal(await page.evaluate(()=>bubbleBatches(selPanel().overlays).length),2);await page.click('#undoBtn');assert.equal(await page.evaluate(()=>bubbleBatches(selPanel().overlays).length),1);
await page.evaluate(()=>{delete selPanel().overlays[0].voice;save();flushLocal();});await page.reload();await page.waitForFunction(()=>selPanel().overlays.length===3);assert.equal(await page.evaluate(()=>bubbleBatches(selPanel().overlays).length),1);assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({...report,undo:true,reload:true,errors},null,2));console.log('PASS: all 9 native shapes, mixed groups, internal border removal, independent timing, PNG/PSD editable text, print transforms, split/undo and reload');
}finally{if(browser)await browser.close();server.close();}})().catch(e=>{console.error(e);process.exitCode=1;});

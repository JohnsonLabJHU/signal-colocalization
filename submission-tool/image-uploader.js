/* =====================================================================
 * Johnson Lab ELN — shared image uploader  (window.ElabImageUploader)
 * ---------------------------------------------------------------------
 * ONE source of truth for the microscopy naming convention + cloud upload,
 * used by the image-upload tool, the colocalization tool, and any future
 * data/image tool (calcium imaging, etc.). It enforces the canonical
 *   EXP{serial}/{animal}/{tissue}[-{eye}]/{MODALITY}_{MAG}_{MARKERS}_{YYYYMMDD}_{NN}.ext
 * naming, uploads the real bytes to blob through the /blobapi relay, and
 * creates a linked, searchable "Data files" record for every image.
 *
 * Usage:
 *   const up = await ElabImageUploader.mount({
 *     mount: document.querySelector('#uploader'),   // container element
 *     api,                                          // async (method,path,body)->{status,data,location}
 *     me: 'Full Name',                              // uploader name (optional)
 *     experiment: {id, title},                      // pre-bind (optional; else the widget shows a picker)
 *     relayContainer: 'microscopy',                 // blob container (default 'microscopy')
 *     onCommit: (results)=>{}                        // results: [{file,canonicalName,blobContainer,blobPath,pointer,recordId}]
 *   });
 *   up.getResults();   // committed results so far
 * ===================================================================== */
(function () {
  const MODALITY = [['confocal','Confocal'],['lightsheet','Light-sheet'],['widefield','Widefield / epifluorescence'],['twophoton','Two-photon'],['aoslo','In vivo (AO-SLO / MicronV)'],['oct','OCT'],['other','Other']];
  const TISSUE   = [['retina','Retina'],['eye','Eye'],['optic-nerve','Optic nerve'],['brain','Brain'],['cell-culture','Cell culture'],['other','Other']];
  const EYE_MAP  = { OD:'OD (right)', OS:'OS (left)' };
  const FLUOROS  = ['405','488','568','594','647','DAPI','GFP','EGFP','tdTomato','mCherry','RFP','Cy3','Cy5','AF488','AF568','AF594','AF647','Brightfield'];
  // Molecular proteins / tracers that aren't in the antibody inventory but are valid imaging targets.
  const EXTRA_TARGETS = ['GD Dendrimer','HD Dendrimer','GFP','RFP','tdTomato','mCitrine','mNeonGreen'];
  const IMG_EXT  = /\.(czi|nd2|lif|tif|tiff|oir|lsm|ims|ome\.tif|ome\.tiff)$/i;
  const DEFAULT_CONTAINER = 'microscopy';

  const esc  = s => String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const slug = s => String(s==null?'':s).trim().replace(/\s+/g,'').replace(/[^A-Za-z0-9.\-+]/g,'').replace(/^\.+|\.+$/g,'');
  const meta = it => { try { return JSON.parse(it.metadata||'{}'); } catch(e){ return {}; } };
  const fvv  = (it,n)=>{ const f=(meta(it).extra_fields||{})[n]; return f?(f.value||''):''; };
  const idFromLoc = l => { if(!l) return null; const t=String(l).replace(/\/+$/,'').split('/').pop(); return /^\d+$/.test(t)?+t:null; };

  const CSS = `
  .eiu .card{border:1px solid var(--line,#e7dada);border-radius:10px;padding:12px;margin:10px 0;background:#fff}
  .eiu .step{font-weight:600;margin-bottom:6px}
  .eiu label{display:block;font-size:.75rem;color:#666;margin-bottom:2px}
  .eiu .row{display:flex;flex-wrap:wrap;gap:10px}
  .eiu input,.eiu select{padding:5px 7px;border:1px solid var(--line,#e7dada);border-radius:7px;font:inherit}
  .eiu .drop{border:2px dashed #cfc2c2;border-radius:10px;padding:16px;text-align:center;color:#888;cursor:pointer}
  .eiu .drop.over{border-color:#7a2433;color:#7a2433;background:#fdf6f7}
  .eiu table{border-collapse:collapse;width:100%;font-size:.8rem}
  .eiu th,.eiu td{border:1px solid var(--line,#eee);padding:4px 6px;text-align:left;vertical-align:top}
  .eiu th{background:#f2f2f8}
  .eiu tr.bad{background:#fff6f6}
  .eiu .tag{display:inline-block;width:16px;height:16px;line-height:16px;text-align:center;border-radius:50%;color:#fff;font-size:.7rem}
  .eiu .tag.ok{background:#2e8b4f}.eiu .tag.bad{background:#b23a48}
  .eiu .warn{color:#b23a48;font-size:.68rem;margin-top:2px}
  .eiu .chan{display:flex;align-items:center;gap:3px;margin-bottom:2px}
  .eiu .chan input{width:78px}.eiu .chan .x{border:none;background:#eee;border-radius:50%;cursor:pointer;width:18px;height:18px}
  .eiu .canon{font-family:ui-monospace,Menlo,monospace;font-size:.72rem}
  .eiu .btn{padding:6px 12px;border:1px solid var(--line,#ddd);border-radius:8px;background:#7a2433;color:#fff;cursor:pointer}
  .eiu .btn.sec{background:#fff;color:#333}
  .eiu .btn.sm{padding:3px 8px;font-size:.72rem}
  .eiu .btn:disabled{opacity:.5;cursor:not-allowed}
  .eiu .muted{color:#888}.eiu .sm{font-size:.78rem}
  `;

  function injectCSS(){ if(document.getElementById('eiu-css')) return; const s=document.createElement('style'); s.id='eiu-css'; s.textContent=CSS; document.head.appendChild(s); }

  async function mount(opts){
    injectCSS();
    const api = opts.api;
    const relayContainer = opts.relayContainer || DEFAULT_CONTAINER;
    const uploadUrl = opts.uploadUrl || '/blobapi/upload';   // your upload-relay endpoint
    const dataStore = opts.dataStore || 'Data files';        // ELN record type for the file archive
    const root = opts.mount; root.classList.add('eiu');
    const ME = opts.me || '';

    // ---- reference data ----
    const cats  = (await api('GET','/teams/current/resources_categories')).data||[];
    const types = (await api('GET','/items_types')).data||[];
    const DATA_TID = (types.find(t=>t.title===dataStore)||{}).id||null;
    const DATA_CAT = (cats.find(c=>c.title===dataStore)||{}).id||null;
    const acat=(cats.find(c=>c.title==='Animals')||{}).id, tcat=(cats.find(c=>c.title==='Tissue samples')||{}).id, abcat=(cats.find(c=>/^antibod/i.test(c.title||''))||{}).id;
    const [ra,rt,rab]=await Promise.all([
      acat?api('GET','/items?cat='+acat+'&extended=1&limit=9999'):Promise.resolve({data:[]}),
      tcat?api('GET','/items?cat='+tcat+'&extended=1&limit=9999'):Promise.resolve({data:[]}),
      abcat?api('GET','/items?cat='+abcat+'&extended=1&limit=9999'):Promise.resolve({data:[]})
    ]);
    const ANIMALS=(Array.isArray(ra.data)?ra.data:[]).map(it=>({id:it.id,aid:fvv(it,'Animal ID')||fvv(it,'Mouse ID')||it.title,title:it.title}));
    const TISSUES=(Array.isArray(rt.data)?rt.data:[]).map(it=>({id:it.id,animal:fvv(it,'Source animal'),type:fvv(it,'Tissue type'),lat:fvv(it,'Laterality'),title:it.title}));
    // Only PRIMARY antibodies matter as imaging targets — drop anything marked "Secondary"
    // (the antibody store has a "Primary / secondary" field). Then add the tracers/proteins.
    const abPrimaries=(Array.isArray(rab.data)?rab.data:[])
      .filter(it=>!/second/i.test(fvv(it,'Primary / secondary')))
      .map(it=>fvv(it,'Target / antigen')||fvv(it,'Target')).filter(Boolean);
    const AB_TARGETS=[...new Set([...EXTRA_TARGETS, ...abPrimaries])].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase()));
    let EXPS=[];
    if(!opts.experiment){ EXPS=((await api('GET','/experiments?limit=9999')).data||[]).map(e=>({id:e.id,title:e.title||'',status_title:e.status_title||''})); }

    // ---- session + rows state ----
    const S = { exp:opts.experiment||null, expSerial:'', tissueTok:'', modality:'', mag:'', date:'' };
    if(S.exp) S.expSerial=((String(S.exp.title||'').match(/\b(\d{3,4})\b/)||[])[1]||'');
    let ROWS=[]; const RESULTS=[];
    // Dedup: images already archived for this experiment (keyed by lowercased original filename),
    // so we never upload a second copy of the same file to blob (storage cost + confusion).
    let EXISTING={}, existingExpId=null;

    // ---- convention helpers ----
    // Cell culture has no animal / eye — those fields are hidden and dropped from the path.
    const isCellCulture = () => S.tissueTok === 'cell-culture';
    const markersStr = ch => (ch||[]).filter(c=>c.target&&c.fluoro).map(c=>slug(c.target)+'-'+slug(c.fluoro)).join('+');
    const buildName = r => { const mk=markersStr(r.channels)||'nomarker'; const nn=String(r.slide||'1').replace(/\D/g,'').padStart(2,'0'); return `${S.modality||'other'}_${slug(S.mag||'na')}_${mk}_${(S.date||'').replace(/-/g,'')}_${nn}.${r.ext}`; };
    const buildPath = r => isCellCulture()
      ? `EXP${S.expSerial||'0000'}/cell-culture/${buildName(r)}`
      : `EXP${S.expSerial||'0000'}/${slug(r.animal||'unknown')}/${(S.tissueTok||'tissue')+(r.eye?('-'+r.eye):'')}/${buildName(r)}`;
    const resolveAnimal = aid => ANIMALS.find(a=>a.aid===aid)||null;
    const resolveTissue = (aid,tok,eye)=>{ const type=(TISSUE.find(([k])=>k===tok)||[])[1]; const want=EYE_MAP[eye]||'N/A'; return TISSUES.find(t=>t.animal===aid&&t.type===type&&(!eye||t.lat===want))||null; };
    function rowWarnings(r){ const w=[];
      if(!S.exp) w.push('pick the experiment'); if(!S.tissueTok) w.push('pick a tissue'); if(!S.modality) w.push('pick a modality'); if(!S.mag) w.push('enter magnification'); if(!S.date) w.push('enter the date');
      if(!isCellCulture()){ if(!r.animal) w.push('animal?'); else if(!resolveAnimal(r.animal)) w.push('animal '+r.animal+' not found'); }
      if(!markersStr(r.channels)) w.push('add at least one Target-Fluorophore'); return w; }

    function parseFolder(folderName){
      const toks=String(folderName||'').split(/[_\s]+/).filter(Boolean); const got=[];
      for(const t of toks){ let m;
        if((m=t.match(/^E(?:XP)?0*(\d+)$/i))){ if(!S.exp) S.expSerial=m[1]; got.push('experiment'); continue; }
        if(TISSUE.some(([k])=>k===t.toLowerCase())){ S.tissueTok=t.toLowerCase(); got.push('tissue'); continue; }
        if((m=t.match(/^([a-z]+?)(\d+(?:\.\d+)?x)$/i))){ const mk=MODALITY.find(([k])=>k===m[1].toLowerCase()); if(mk){ S.modality=mk[0]; S.mag=m[2].toLowerCase(); got.push('modality','mag'); continue; } }
        if(MODALITY.some(([k])=>k===t.toLowerCase())){ S.modality=t.toLowerCase(); got.push('modality'); continue; }
        if(/^\d+(\.\d+)?x$/i.test(t)){ S.mag=t.toLowerCase(); got.push('mag'); continue; }
        if((m=t.match(/^(\d{4})[-]?(\d{2})[-]?(\d{2})$/))){ S.date=m[1]+'-'+m[2]+'-'+m[3]; got.push('date'); continue; }
      }
      return [...new Set(got)];
    }
    function parseShort(fname){
      const stem=fname.replace(/\.[^.]+$/,''); const rec={};
      const toks=stem.split(/[-_\s]+/).filter(Boolean);
      const eyeIdx=toks.findIndex(t=>/^(OD|OS)$/i.test(t)); rec.eye=eyeIdx>=0?toks[eyeIdx].toUpperCase():'';
      let slTok=toks.find(t=>/^s(?:lide)?\d+$/i.test(t));
      if(!slTok && eyeIdx>=0){ for(let k=toks.length-1;k>eyeIdx;k--){ if(/^\d+$/.test(toks[k])){ slTok=toks[k]; break; } } }
      rec.slide=slTok?slTok.replace(/\D/g,''):'';
      const known=ANIMALS.find(a=>a.aid && new RegExp('(^|[^A-Za-z0-9])'+a.aid.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'([^A-Za-z0-9]|$)','i').test(stem));
      rec.animal=known?known.aid:(toks[0]||stem);
      return rec;
    }

    // ---- render skeleton ----
    root.innerHTML = `
      <datalist id="eiu-targets">${AB_TARGETS.map(t=>`<option value="${esc(t)}">`).join('')}</datalist>
      <datalist id="eiu-fluoros">${FLUOROS.map(t=>`<option value="${esc(t)}">`).join('')}</datalist>
      <datalist id="eiu-animals">${ANIMALS.map(a=>`<option value="${esc(a.aid)}">`).join('')}</datalist>
      <div class="card">
        <div class="step">Session details ${S.exp?('— <span class="sm muted">experiment #'+S.exp.id+'</span>'):''}</div>
        <div class="row">
          ${S.exp?'':`<div><label>Experiment</label><select id="eiu-exp"><option value="">— choose —</option>${EXPS.map(e=>`<option value="${e.id}">${esc(e.title||('Experiment '+e.id))}</option>`).join('')}</select></div>`}
          <div><label>Tissue</label><select id="eiu-tissue"><option value="">—</option>${TISSUE.map(([k,l])=>`<option value="${k}">${esc(l)}</option>`).join('')}</select></div>
          <div><label>Modality</label><select id="eiu-mod"><option value="">—</option>${MODALITY.map(([k,l])=>`<option value="${k}">${esc(l)}</option>`).join('')}</select></div>
          <div><label>Magnification</label><input id="eiu-mag" placeholder="e.g. 20x" style="width:80px"></div>
          <div><label>Acquisition date</label><input id="eiu-date" type="date"></div>
        </div>
        <p class="sm muted" id="eiu-parsed" style="margin:8px 0 0"></p>
      </div>
      <div class="card">
        <div class="step">Choose images</div>
        <div class="drop" id="eiu-drop">Drag a folder or files here, or <label style="display:inline;color:#7a2433;cursor:pointer;text-decoration:underline">browse<input id="eiu-picker" type="file" multiple accept=".czi,.nd2,.lif,.tif,.tiff,.oir,.lsm,.ims" style="display:none"></label>. The folder name pre-fills the session fields.</div>
        <p class="sm muted" id="eiu-picked" style="margin:6px 0 0"></p>
      </div>
      <div class="card" id="eiu-filecard" style="display:none">
        <div class="step">Confirm each image <span class="sm muted">— fill anything flagged; names are rebuilt to the lab convention</span></div>
        <div style="overflow:auto"><table id="eiu-tbl"></table></div>
        <div class="row" style="align-items:center;margin-top:8px">
          <button class="btn sec sm" id="eiu-applyall" title="copy the first row's channels to all rows">apply channels to all</button>
          <button class="btn" id="eiu-commit" disabled>Upload</button>
          <span id="eiu-msg" class="sm muted"></span>
        </div>
      </div>`;

    const $ = s => root.querySelector(s);
    function readSession(){
      if(!S.exp && $('#eiu-exp')){ const e=EXPS.find(x=>String(x.id)===$('#eiu-exp').value); S.exp=e||null; S.expSerial=e?((String(e.title).match(/\b(\d{3,4})\b/)||[])[1]||S.expSerial):''; }
      S.tissueTok=$('#eiu-tissue').value; S.modality=$('#eiu-mod').value; S.mag=$('#eiu-mag').value.trim(); S.date=$('#eiu-date').value;
      renderFiles(); loadExisting();
    }
    // Load the images already archived for this experiment (Data-file records with a blob path),
    // matched by the study serial (EXP<serial>) or the numeric id (EXP<id>). Cached per experiment.
    async function loadExisting(){
      if(!S.exp || !DATA_CAT || existingExpId===S.exp.id) return;
      existingExpId=S.exp.id; EXISTING={};
      try{
        const items=(await api('GET','/items?cat='+DATA_CAT+'&extended=1&limit=9999')).data||[];
        const serial=S.expSerial||((String(S.exp.title||'').match(/\b(\d{3,4})\b/)||[])[1]||'');
        for(const it of items){ const ex=fvv(it,'Experiment');
          if(ex!==('EXP'+S.exp.id) && !(serial&&ex===('EXP'+serial))) continue;
          const path=fvv(it,'Blob path'); if(!path) continue;
          const orig=(fvv(it,'Original file name')||fvv(it,'File name')||'').toLowerCase(); if(!orig) continue;
          EXISTING[orig]={pointer:'blob:'+(fvv(it,'Blob container')||'microscopy')+'/'+path, recordId:it.id, canonicalName:fvv(it,'File name')||orig};
        }
      }catch(e){}
      renderFiles();
    }
    function fillSession(got){
      $('#eiu-tissue').value=S.tissueTok||''; $('#eiu-mod').value=S.modality||''; $('#eiu-mag').value=S.mag||''; $('#eiu-date').value=S.date||'';
      $('#eiu-parsed').textContent=got.length?('Read from folder name: '+got.join(', ')+'. Confirm or complete the rest.'):'Fill the session fields above.';
      readSession();
    }
    ['eiu-tissue','eiu-mod','eiu-mag','eiu-date'].forEach(id=>{ const el=$('#'+id); el.oninput=el.onchange=readSession; });
    if($('#eiu-exp')) $('#eiu-exp').onchange=readSession;

    // ---- file intake ----
    async function filesFromDrop(dt){
      const out=[]; const items=[...(dt.items||[])].map(i=>i.webkitGetAsEntry&&i.webkitGetAsEntry()).filter(Boolean);
      if(!items.length) return [...(dt.files||[])];
      async function walk(entry,path){
        if(entry.isFile){ await new Promise(res=>entry.file(f=>{ try{Object.defineProperty(f,'webkitRelativePath',{value:path+entry.name});}catch(_){} out.push(f); res(); })); }
        else if(entry.isDirectory){ const rd=entry.createReader(); await new Promise(res=>rd.readEntries(async es=>{ for(const c of es) await walk(c,path+entry.name+'/'); res(); })); }
      }
      for(const it of items) await walk(it,''); return out;
    }
    async function ingest(files){
      const imgs=files.filter(f=>IMG_EXT.test(f.name));
      $('#eiu-picked').textContent=imgs.length+' image file(s) selected'+(files.length>imgs.length?(' ('+(files.length-imgs.length)+' non-image skipped)'):'');
      if(!imgs.length) return;
      const folder=(imgs[0].webkitRelativePath||'').split('/')[0]||'';
      if(!S.exp){ S.expSerial=''; } S.tissueTok=S.modality=S.mag=S.date='';
      const got=parseFolder(folder);
      ROWS=[];
      for(const f of imgs){ const short=(f.webkitRelativePath||f.name).split('/').pop(); const rec=parseShort(short);
        const ext=(short.match(/\.([^.]+)$/)||[])[1]||'';
        ROWS.push({file:short, ext:ext.toLowerCase(), animal:rec.animal, eye:rec.eye, slide:rec.slide, size:f.size, fileObj:f, channels:[{target:'',fluoro:''}]}); }
      $('#eiu-filecard').style.display=''; fillSession(got);
    }
    const drop=$('#eiu-drop');
    $('#eiu-picker').onchange=e=>ingest([...e.target.files]);
    drop.ondragover=e=>{ e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave=()=>drop.classList.remove('over');
    drop.ondrop=async e=>{ e.preventDefault(); drop.classList.remove('over'); ingest(await filesFromDrop(e.dataTransfer)); };
    $('#eiu-applyall').onclick=()=>{ if(!ROWS.length) return; const src=JSON.stringify(ROWS[0].channels); ROWS.forEach(r=>r.channels=JSON.parse(src)); renderFiles(); };

    // ---- file table ----
    function renderFiles(){
      if(!ROWS.length){ $('#eiu-filecard').style.display='none'; return; }
      let okN=0; const cc=isCellCulture();
      const pathPreview=r=>cc ? ('EXP'+(S.expSerial||'?')+'/cell-culture') : ('EXP'+(S.expSerial||'?')+'/'+(r.animal||'?')+'/'+((S.tissueTok||'?')+(r.eye?'-'+r.eye:'')));
      $('#eiu-tbl').innerHTML='<thead><tr><th></th><th>File</th>'+(cc?'':'<th>Animal</th><th>Eye</th>')+'<th>Slide</th><th>Markers (Target-Fluorophore)</th><th>Canonical name</th></tr></thead><tbody>'+
        ROWS.map((r,i)=>{ const w=rowWarnings(r); if(!w.length) okN++;
          const dup=EXISTING[(r.file||'').toLowerCase()];
          const chans=r.channels.map((c,j)=>`<div class="chan"><input list="eiu-targets" data-ct="${i}:${j}" value="${esc(c.target)}" placeholder="target"><span>-</span><input list="eiu-fluoros" data-cf="${i}:${j}" value="${esc(c.fluoro)}" placeholder="fluoro"><button class="x" data-cx="${i}:${j}">×</button></div>`).join('')+`<button class="btn sec sm" data-cadd="${i}">+ channel</button>`;
          const animalEye = cc ? '' : `<td><input type="text" data-fa="${i}" value="${esc(r.animal)}" list="eiu-animals" style="width:90px"></td>
            <td><select data-fe="${i}"><option value=""${r.eye?'':' selected'}>—</option><option${r.eye==='OD'?' selected':''}>OD</option><option${r.eye==='OS'?' selected':''}>OS</option></select></td>`;
          return `<tr class="${w.length?'bad':''}"><td><span class="tag ${w.length?'bad':'ok'}">${w.length?'!':'✓'}</span></td>
            <td class="sm">${esc(r.file)}${w.length?('<div class="warn">'+w.map(esc).join('; ')+'</div>'):''}${dup?'<div style="color:#1e6b34;font-size:.68rem">↳ already in the archive — will reuse, not re-uploaded</div>':''}</td>
            ${animalEye}
            <td><input type="text" data-fs="${i}" value="${esc(r.slide)}" style="width:46px"></td>
            <td>${chans}</td>
            <td class="canon">${esc(buildName(r))}<div class="muted" style="font-size:.66rem">${esc(pathPreview(r))}/</div></td></tr>`;
        }).join('')+'</tbody>';
      $('#eiu-tbl').querySelectorAll('[data-fa]').forEach(el=>el.oninput=e=>{ ROWS[+e.target.dataset.fa].animal=e.target.value; renderFiles(); });
      $('#eiu-tbl').querySelectorAll('[data-fe]').forEach(el=>el.onchange=e=>{ ROWS[+e.target.dataset.fe].eye=e.target.value; renderFiles(); });
      $('#eiu-tbl').querySelectorAll('[data-fs]').forEach(el=>el.oninput=e=>{ ROWS[+e.target.dataset.fs].slide=e.target.value; renderFiles(); });
      $('#eiu-tbl').querySelectorAll('[data-ct]').forEach(el=>el.oninput=e=>{ const [i,j]=e.target.dataset.ct.split(':').map(Number); ROWS[i].channels[j].target=e.target.value; refreshOk(); });
      $('#eiu-tbl').querySelectorAll('[data-cf]').forEach(el=>el.oninput=e=>{ const [i,j]=e.target.dataset.cf.split(':').map(Number); ROWS[i].channels[j].fluoro=e.target.value; refreshOk(); });
      $('#eiu-tbl').querySelectorAll('[data-cx]').forEach(el=>el.onclick=e=>{ const [i,j]=e.target.dataset.cx.split(':').map(Number); ROWS[i].channels.splice(j,1); if(!ROWS[i].channels.length) ROWS[i].channels.push({target:'',fluoro:''}); renderFiles(); });
      $('#eiu-tbl').querySelectorAll('[data-cadd]').forEach(el=>el.onclick=e=>{ ROWS[+e.target.dataset.cadd].channels.push({target:'',fluoro:''}); renderFiles(); });
      const btn=$('#eiu-commit'); btn.disabled=!okN; btn.textContent=okN?('⬆ Upload '+okN+' image(s) to the cloud'):'Nothing ready yet';
    }
    function refreshOk(){ const okN=ROWS.filter(x=>!rowWarnings(x).length).length; const btn=$('#eiu-commit'); btn.disabled=!okN; btn.textContent=okN?('⬆ Upload '+okN+' image(s) to the cloud'):'Nothing ready yet'; }

    // ---- commit: blob upload (real) + Data-file record ----
    async function newItem(typeId){ const cr=await api('POST','/items/'+typeId,{}); let nid=idFromLoc(cr.location)||(cr.data&&cr.data.id)||null; return nid; }
    async function uploadBytes(fileObj, blobPath){
      const url=uploadUrl+'?container='+encodeURIComponent(relayContainer)+'&path='+encodeURIComponent(blobPath)+'&ct='+encodeURIComponent(fileObj.type||'application/octet-stream');
      const r=await fetch(url,{method:'POST',body:fileObj});
      if(!r.ok) throw new Error('upload failed ('+r.status+'): '+(await r.text()));
      return (await r.json());
    }
    async function commit(){
      const good=ROWS.filter(r=>!rowWarnings(r).length); if(!good.length) return;
      const msg=$('#eiu-msg'); $('#eiu-commit').disabled=true;
      const tissueLabel=(TISSUE.find(([k])=>k===S.tissueTok)||[])[1]||S.tissueTok;
      const modLabel=(MODALITY.find(([k])=>k===S.modality)||[])[1]||S.modality;
      let done=0, reused=0;
      for(const r of good){
        // Dedup: if this experiment already has an image with the same filename, reuse the archived
        // copy instead of uploading a second one (saves cloud storage; avoids duplicate records).
        const dup=EXISTING[(r.file||'').toLowerCase()];
        if(dup){
          msg.style.color=''; msg.textContent='Reusing archived copy: '+r.file+' …';
          RESULTS.push({file:r.file, canonicalName:dup.canonicalName, blobContainer:'', blobPath:'', pointer:dup.pointer, recordId:dup.recordId, duplicate:true});
          done++; reused++; continue;
        }
        msg.style.color=''; msg.textContent='Uploading '+(done+1)+'/'+good.length+': '+r.file+' …';
        try{
          const canonical=buildName(r), blobPath=buildPath(r);
          const up=await uploadBytes(r.fileObj, blobPath);            // real bytes → blob
          let recordId=null;
          if(DATA_TID&&DATA_CAT){
            const nid=await newItem(DATA_TID);
            if(nid){
              const m=meta((await api('GET','/items/'+nid)).data||{}); const ef=m.extra_fields||(m.extra_fields={});
              const set=(k,v)=>{ if(ef[k]) ef[k].value=(v==null?'':String(v)); else ef[k]={type:'text',value:(v==null?'':String(v))}; };
              const cc=isCellCulture();
              const an=cc?null:resolveAnimal(r.animal), ti=cc?null:resolveTissue(r.animal,S.tissueTok,r.eye);
              set('File name',canonical); set('Original file name',r.file); set('Experiment','EXP'+S.expSerial); set('Source animal',cc?'':r.animal);
              set('Tissue',tissueLabel); set('Laterality',cc?'N/A':(EYE_MAP[r.eye]||'N/A')); set('Slide',r.slide); set('Modality',modLabel); set('Magnification',S.mag);
              set('Marker / channel',markersStr(r.channels).split('+').join(', ')); set('Acquisition date',S.date);
              set('Blob container',up.container||relayContainer); set('Blob path',up.path||blobPath);
              set('File size (GB)',(r.size/1e9).toFixed(3)); set('Storage tier','Hot'); set('Uploaded by',ME); set('Upload date',new Date().toISOString().slice(0,10));
              const titlePrefix=cc?tissueLabel:(r.animal+' '+tissueLabel+(r.eye?(' '+r.eye):''));
              await api('PATCH','/items/'+nid,{title:titlePrefix+' — '+modLabel+' ('+S.date+')', category:DATA_CAT, metadata:JSON.stringify(m)});
              if(S.exp) await api('POST','/experiments/'+S.exp.id+'/items_links/'+nid);
              if(an) await api('POST','/items/'+nid+'/items_links/'+an.id);
              if(ti) await api('POST','/items/'+nid+'/items_links/'+ti.id);
              recordId=nid;
            }
          }
          RESULTS.push({file:r.file, canonicalName:canonical, blobContainer:up.container||relayContainer, blobPath:up.path||blobPath, pointer:up.pointer||('blob:'+(up.container||relayContainer)+'/'+(up.path||blobPath)), recordId});
          done++;
        }catch(err){ msg.style.color='#b23a48'; msg.textContent='⚠ '+r.file+': '+err.message; $('#eiu-commit').disabled=false; return; }
      }
      const uploaded=done-reused;
      msg.style.color='#1e6b34';
      msg.textContent='✓ '+(uploaded>0?('Uploaded '+uploaded+' image(s) to the cloud'):'Done')+(reused>0?(' · '+reused+' already in the archive (reused, not re-uploaded)'):'')+'.';
      existingExpId=null; loadExisting();   // refresh the dedup set so a repeat commit reuses these
      if(typeof opts.onCommit==='function') opts.onCommit(RESULTS.slice(), Object.assign({},S));
      $('#eiu-commit').disabled=false;
    }
    $('#eiu-commit').onclick=commit;

    return { getResults:()=>RESULTS.slice(), get session(){ return Object.assign({},S); } };
  }

  window.ElabImageUploader = { mount, MODALITY, TISSUE, FLUOROS, IMG_EXT, version:'1.0' };
})();

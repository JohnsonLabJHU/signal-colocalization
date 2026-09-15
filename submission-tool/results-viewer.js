/* =====================================================================
 * Johnson Lab ELN — shared results viewer  (window.ElabResults)
 * ---------------------------------------------------------------------
 * A drop-in file browser for the outputs of any analysis run, so users
 * view/download results without opening native eLabFTW. Used by the
 * colocalization tool's "Recent analyses" and by future analysis tools.
 *
 *   await ElabResults.mount({ mount: el, api, entity: 'items'|'experiments', id: <recordId> });
 *
 * Renders each attached file with view (images open inline) + download,
 * checkboxes for multi-select, and one-click "download all". Files are
 * eLabFTW uploads on the entity; downloads use the same-origin session.
 * ===================================================================== */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const IMG = /\.(png|jpe?g|gif|webp|bmp)$/i;
  const XL  = /\.(xlsx|xls|csv|tsv)$/i;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const CSS = `
  .erv{font-size:.85rem}
  .erv .ctl{display:flex;gap:8px;align-items:center;margin:8px 0 6px;flex-wrap:wrap}
  .erv .erv-btn{border:1px solid #cbbcbe;background:#fff;border-radius:7px;padding:4px 10px;font:inherit;font-size:.8rem;cursor:pointer;color:#3b5bdb}
  .erv .erv-btn.primary{background:#3b5bdb;color:#fff;border-color:#3b5bdb}
  .erv .erv-btn:disabled{opacity:.5;cursor:default}
  .erv table{width:100%;border-collapse:collapse}
  .erv td,.erv th{padding:4px 7px;border-bottom:1px solid #efe9ea;text-align:left;vertical-align:middle}
  .erv th{font-size:.68rem;text-transform:uppercase;letter-spacing:.03em;color:#8a7f80}
  .erv td.num{text-align:right;font-variant-numeric:tabular-nums;color:#666}
  .erv a.act{color:#3b5bdb;cursor:pointer;text-decoration:none;margin-right:10px}
  .erv a.act:hover{text-decoration:underline}
  .erv .grp{font-size:.7rem;text-transform:uppercase;letter-spacing:.03em;color:#8a7f80;padding-top:8px}
  .erv .muted{color:#8a7f80}
  `;
  function injectCSS(){ if (document.getElementById('erv-css')) return; const s=document.createElement('style'); s.id='erv-css'; s.textContent=CSS; document.head.appendChild(s); }
  function fmtSize(n){ n=+n||0; if(n>=1048576) return (n/1048576).toFixed(1)+' MB'; if(n>=1024) return (n/1024).toFixed(0)+' KB'; return n+' B'; }
  function icon(name){ if(IMG.test(name)) return '🖼️'; if(/\.xlsx?$/i.test(name)) return '📊'; if(/\.(csv|tsv)$/i.test(name)) return '📄'; if(/\.pdf$/i.test(name)) return '📕'; return '📎'; }

  async function mount(opts){
    injectCSS();
    const { mount: el, api, entity, id } = opts;
    el.classList.add('erv');
    el.innerHTML = '<span class="muted">Loading files…</span>';
    const base = '/api/v2/' + entity + '/' + id + '/uploads';
    const binUrl = uid => base + '/' + uid + '?format=binary';

    let ups = [];
    try { const r = await api('GET', '/' + entity + '/' + id + '/uploads'); ups = Array.isArray(r.data) ? r.data : []; }
    catch(e){ el.innerHTML = '<span class="muted">Could not load files.</span>'; return; }
    if (!ups.length){ el.innerHTML = '<span class="muted">No files attached yet.</span>'; return; }

    // group order: workbooks/data first, then images, then everything else
    const rank = n => XL.test(n) ? 0 : (IMG.test(n) ? 1 : 2);
    ups = ups.map(u => ({ id: u.id, name: u.real_name || ('file-'+u.id), size: u.filesize || 0 }))
             .sort((a,b) => rank(a.name)-rank(b.name) || String(a.name).localeCompare(String(b.name)));

    function download(u){
      const a = document.createElement('a');
      a.href = binUrl(u.id); a.download = u.name;
      document.body.appendChild(a); a.click(); a.remove();
    }
    async function downloadMany(list){
      if(!list.length) return;
      for (const u of list){ download(u); await sleep(350); }   // stagger so the browser keeps them all
    }
    async function view(u){
      if(IMG.test(u.name)){
        try{ const resp=await fetch(binUrl(u.id)); const b=await resp.blob(); const url=URL.createObjectURL(b);
             window.open(url,'_blank'); setTimeout(()=>URL.revokeObjectURL(url), 60000); }
        catch(e){ download(u); }
      } else { download(u); }
    }

    let lastGrp = -1;
    const rows = ups.map((u,i)=>{
      const g = rank(u.name); let hdr='';
      if(g!==lastGrp){ lastGrp=g; const label = g===0?'Data (workbook / tables)' : (g===1?'QC images' : 'Other'); hdr=`<tr><td colspan="4" class="grp">${label}</td></tr>`; }
      return hdr + `<tr>
        <td><input type="checkbox" data-i="${i}" checked></td>
        <td>${icon(u.name)} ${esc(u.name)}</td>
        <td class="num">${fmtSize(u.size)}</td>
        <td>${IMG.test(u.name)?`<a class="act" data-view="${i}">view</a>`:''}<a class="act" data-dl="${i}">download</a></td></tr>`;
    }).join('');

    el.innerHTML = `
      <div class="ctl">
        <button class="erv-btn" data-all>Select all</button>
        <button class="erv-btn" data-none>Select none</button>
        <button class="erv-btn primary" data-dlsel>⤓ Download selected</button>
        <span class="muted">${ups.length} file(s) · your browser may ask once to allow multiple downloads</span>
      </div>
      <table><thead><tr><th></th><th>File</th><th class="num">Size</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`;

    const boxes = () => [...el.querySelectorAll('input[data-i]')];
    const selected = () => boxes().filter(b=>b.checked).map(b=>ups[+b.dataset.i]);
    el.querySelector('[data-all]').onclick = ()=> boxes().forEach(b=>b.checked=true);
    el.querySelector('[data-none]').onclick = ()=> boxes().forEach(b=>b.checked=false);
    el.querySelector('[data-dlsel]').onclick = async (e)=>{ const btn=e.currentTarget; btn.disabled=true; const before=btn.textContent; btn.textContent='Downloading…'; await downloadMany(selected()); btn.textContent=before; btn.disabled=false; };
    el.querySelectorAll('[data-dl]').forEach(a=>a.onclick=()=>download(ups[+a.dataset.dl]));
    el.querySelectorAll('[data-view]').forEach(a=>a.onclick=()=>view(ups[+a.dataset.view]));
  }

  window.ElabResults = { mount, version: '1.0' };
})();

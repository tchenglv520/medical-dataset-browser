document.addEventListener('DOMContentLoaded', () => {
  // ---------- Data source fallbacks ----------
  const DATA_URLS = [
    './static/data/cleaned_total.json',
    './cleaned_total.json',
    './data/cleaned_total.json',
    '/api/datasets'
  ];
  async function fetchFirstAvailable(urls) {
    for (const url of urls) {
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (res.ok) {
          const json = await res.json();
          return { url, json };
        }
      } catch {}
    }
    throw new Error('No available dataset source found.');
  }

  // ---------- Global state ----------
  let allDatasets = [];
  let baseDatasets = [];
  let currentFilteredData = [];
  const charts = {};
  const chartClickState = {};
  let baseLabel = 'All datasets';

  // infinite scroll
  let currentPage = 1;
  const itemsPerPage = 100;
  let isLoading = false;

  // ---------- DOM ----------
  const tableBody = document.getElementById('table-body');
  const searchBox = document.getElementById('search-box');
  const dimensionFilter = document.getElementById('dimension-filter');
  const modalityFilter = document.getElementById('modality-filter');
  const taskFilter = document.getElementById('task-filter');
  const includeMixedBox = document.getElementById('include-mixed-dimension');

  const noResultsDiv = document.getElementById('no-results');
  const loadingIndicator = document.getElementById('loading-indicator');
  const resultsCount = document.getElementById('results-count');

  // JSON Mode
  const jsonTextarea = document.getElementById('filter-json');
  const btnPhase12 = document.getElementById('btn-apply-phase12');
  const btnPhase34 = document.getElementById('btn-apply-phase3');
  const jsonError  = document.getElementById('json-error');
  const hintP12 = document.getElementById('hint-p12');
  const hintP34 = document.getElementById('hint-p34');

  // Phase charts canvases
  const canvasPhase12Bar  = document.getElementById('phase12-modality-bar');
  const canvasPhase3Bar   = document.getElementById('phase3-modality-bar');
  const canvasPhase12Pie  = document.getElementById('phase12-task-pie');
  const canvasPhase3Pie   = document.getElementById('phase3-task-pie');

  // Phase 4 table
  const statsBody = document.getElementById('stats-body');

  // ---------- Utils ----------
  const PALETTE = ['#0d6efd','#6f42c1','#d63384','#fd7e14','#ffc107','#198754','#20c997','#0dcaf0','#6c757d','#adb5bd'];

  function toArray(v){ if(Array.isArray(v)) return v; if(v==null) return []; return [v]; }
  function sanitizeNumber(v){
    if(typeof v==='number') return Number.isFinite(v)?v:0;
    if(typeof v==='string'){ const n=Number(v.replace(/[^\d.-]/g,'')); return Number.isFinite(n)?n:0; }
    return 0;
  }
  function getYear(y){ if(!y) return null; const n = Number(String(y).slice(0,4)); return Number.isFinite(n)?n:null; }
  function intersectNonEmpty(a,b){ if(!a||!b) return false; const s=new Set(b.map(x=>String(x).toLowerCase())); return a.some(x=>s.has(String(x).toLowerCase())); }
  function uniq(arr){ return Array.from(new Set(arr)); }

  // canonical dimension flags for a dataset
  function getDimFlags(d){
    const dims = d.dimension.map(x=>String(x).toLowerCase());
    const has2D    = dims.some(x=>x.includes('2d'));
    const has3D    = dims.some(x=>x.includes('3d'));
    const hasVideo = dims.some(x=>x.includes('video'));
    return { has2D, has3D, hasVideo, count:(has2D?1:0)+(has3D?1:0)+(hasVideo?1:0) };
  }

  function readFilterJson(){
    if(!jsonTextarea) return null;
    jsonError.textContent='';
    try{ return JSON.parse(jsonTextarea.value); }
    catch(e){ jsonError.textContent='Invalid JSON: '+e.message; return null; }
  }

  function setPhaseHighlight(which){ // 'p12' | 'p34' | null
    jsonTextarea.classList.remove('phase12-active','phase34-active');
    hintP12?.classList.remove('active');
    hintP34?.classList.remove('active');
    if(which==='p12'){ jsonTextarea.classList.add('phase12-active'); hintP12?.classList.add('active'); }
    if(which==='p34'){ jsonTextarea.classList.add('phase34-active'); hintP34?.classList.add('active'); }
  }

  // ---------- Fetch & init ----------
  async function fetchData(){
    try{
      const {url,json} = await fetchFirstAvailable(DATA_URLS);
      const raw = Array.isArray(json) ? json : (Array.isArray(json?.rows) ? json.rows : []);
      allDatasets = raw.map(d=>({
        ...d,
        name: d.name ?? '',
        organization: d.organization ?? '',
        organ: d.organ ?? '',
        license: d.license ?? '',
        link: d.link ?? d.homepage_url ?? '',
        year: d.year ?? d.release_year ?? '',
        dimension: toArray(d.dimension).map(String),
        modality:  toArray(d.modality ?? d.modalities).map(String),
        task:      toArray(d.task ?? d.task_types).map(String),
        data_volume_total: sanitizeNumber(d.data_volume_total ?? d.images ?? d.number)
      }));
      baseDatasets = allDatasets.slice();
      initialize();
    }catch(err){
      console.error('Failed to load datasets:', err);
      if(tableBody){ tableBody.innerHTML = `<tr><td colspan="10" class="text-center text-danger">Data load failed</td></tr>`; }
    }
  }

  function initialize(){
    if(!allDatasets.length){ noResultsDiv?.classList.remove('d-none'); return; }
    populateFilters();           // only modality/task are populated dynamically
    renderAllCharts(allDatasets);
    setupEventListeners();
    applyFilters();
  }

  // ---------- Populate quick filters ----------
  function populateFilters(){
    const modalities = uniq(allDatasets.flatMap(d=>d.modality)).sort();
    const tasks = uniq(allDatasets.flatMap(d=>d.task)).sort();

    // dimensionFilter is fixed options in HTML (2D/3D/video), so we only populate modality/task
    populateSelect(modalityFilter, modalities);
    populateSelect(taskFilter, tasks);
  }
  function populateSelect(sel, options){
    if(!sel) return;
    options.forEach(opt=>{
      const o=document.createElement('option');
      o.value=opt; o.textContent=opt;
      sel.appendChild(o);
    });
  }

  // ---------- Table ----------
  function appendRowsToTable(datasets){
    if(!tableBody) return;
    const frag = document.createDocumentFragment();
    datasets.forEach(d=>{
      const tr=document.createElement('tr');

      const tdName=document.createElement('td'); const strong=document.createElement('strong'); strong.textContent=d.name||'N/A'; tdName.appendChild(strong);
      const tdDim=document.createElement('td');  const span=document.createElement('span'); span.className='badge bg-secondary'; span.textContent=d.dimension.length?d.dimension.join(', '):'N/A'; tdDim.appendChild(span);
      const tdMod=document.createElement('td');  tdMod.textContent=d.modality.length?d.modality.join(', '):'N/A';
      const tdTask=document.createElement('td'); tdTask.textContent=d.task.length?d.task.join(', '):'N/A';
      const tdOrg=document.createElement('td');  tdOrg.textContent=d.organ||'N/A';
      const tdNum=document.createElement('td');  tdNum.textContent=Number.isFinite(d.data_volume_total)?d.data_volume_total.toLocaleString():'N/A';
      const tdYear=document.createElement('td'); tdYear.textContent=d.year||'N/A';
      const tdCh=document.createElement('td');  tdCh.textContent=d.organization||'N/A';
      const tdLic=document.createElement('td'); tdLic.textContent=d.license||'N/A';

      const tdLink=document.createElement('td');
      if(d.link){
        try{
          const u=new URL(d.link, location.href);
          if(u.protocol==='http:'||u.protocol==='https:'){ const a=document.createElement('a'); a.href=u.href; a.target='_blank'; a.rel='noopener noreferrer'; a.textContent='Access'; tdLink.appendChild(a); }
          else tdLink.textContent='N/A';
        }catch{ tdLink.textContent='N/A'; }
      }else tdLink.textContent='N/A';

      [tdName,tdDim,tdMod,tdTask,tdOrg,tdNum,tdYear,tdCh,tdLic,tdLink].forEach(td=>tr.appendChild(td));
      frag.appendChild(tr);
    });
    tableBody.appendChild(frag);
  }

  // ---------- Infinite scroll ----------
  function loadMoreData(){
    if(isLoading) return;
    const start=(currentPage-1)*itemsPerPage, end=start+itemsPerPage;
    if(start>=currentFilteredData.length){ loadingIndicator?.classList.add('d-none'); return; }
    isLoading=true; loadingIndicator?.classList.remove('d-none');
    setTimeout(()=>{
      appendRowsToTable(currentFilteredData.slice(start,end));
      currentPage++; isLoading=false; loadingIndicator?.classList.add('d-none');
    }, 150);
  }

  // ---------- Apply quick filters (on top of baseDatasets) ----------
  function applyFilters(){
    const searchTerm=(searchBox?.value||'').toLowerCase().trim();
    const selectedDim=(dimensionFilter?.value||'').toLowerCase();
    const includeMixed = !!(includeMixedBox?.checked);
    const selectedMod  = modalityFilter?.value || '';
    const selectedTask = taskFilter?.value || '';

    const source = baseDatasets.length ? baseDatasets : allDatasets;

    currentFilteredData = source.filter(d=>{
      // text search
      const matchesSearch =
        !searchTerm ||
        (d.name && d.name.toLowerCase().includes(searchTerm)) ||
        (d.organization && d.organization.toLowerCase().includes(searchTerm)) ||
        (d.organ && d.organ.toLowerCase().includes(searchTerm));

      // dimension
      let matchesDim = true;
      if(selectedDim){
        const f = getDimFlags(d);
        matchesDim =
          (selectedDim==='2d'    && f.has2D) ||
          (selectedDim==='3d'    && f.has3D) ||
          (selectedDim==='video' && f.hasVideo);
        if(matchesDim && !includeMixed){
          // only keep single-dimension datasets
          if(f.count !== 1) matchesDim = false;
        }
      }

      // modality / task exact includes
      const matchesMod  = !selectedMod  || d.modality.includes(selectedMod);
      const matchesTask = !selectedTask || d.task.includes(selectedTask);

      return matchesSearch && matchesDim && matchesMod && matchesTask;
    });

    const totalVolume = currentFilteredData.reduce((s,ds)=> s + (Number.isFinite(ds.data_volume_total)?ds.data_volume_total:0), 0);

    // reset table & paging
    tableBody.innerHTML=''; currentPage=1;

    const anyQuick = !!(searchTerm || selectedDim || selectedMod || selectedTask || !includeMixed);
    const via = anyQuick ? `${baseLabel} + Quick filters` : baseLabel;

    resultsCount.textContent =
      currentFilteredData.length>0
        ? `Found ${currentFilteredData.length} matching datasets, with approximately ${totalVolume.toLocaleString()} images in total. [via: ${via}]`
        : `Found 0 matching datasets. [via: ${via}]`;

    noResultsDiv?.classList.toggle('d-none', currentFilteredData.length>0);

    // Re-render overview charts with the EXACT current set every time
    // and clear previous click-highlights to avoid confusion
    for(const k of Object.keys(chartClickState)) delete chartClickState[k];
    renderAllCharts(currentFilteredData);

    loadMoreData();
  }

  function setupEventListeners(){
    searchBox?.addEventListener('input', applyFilters);
    dimensionFilter?.addEventListener('change', applyFilters);
    includeMixedBox?.addEventListener('change', applyFilters);
    modalityFilter?.addEventListener('change', applyFilters);
    taskFilter?.addEventListener('change', applyFilters);

    window.addEventListener('scroll', ()=>{
      if(window.innerHeight + window.scrollY >= document.body.offsetHeight - 500) loadMoreData();
    });

    // JSON-driven
    btnPhase12?.addEventListener('click', ()=>{
      const cfg=readFilterJson(); if(!cfg) return;
      setPhaseHighlight('p12');

      const p12=runPhase12(allDatasets,cfg);
      baseDatasets=p12.slice();
      baseLabel='JSON Phase 1&2';
      applyFilters();

      drawPhaseCharts('phase12',p12,cfg);
      updateSummaryTable(p12,p12,cfg);
    });

    btnPhase34?.addEventListener('click', ()=>{
      const cfg=readFilterJson(); if(!cfg) return;
      setPhaseHighlight('p34');

      const p12=runPhase12(allDatasets,cfg);
      const p3 =runPhase3(p12,cfg,true);

      baseDatasets=p3.slice();
      baseLabel='JSON Phase 3&4';
      applyFilters();

      drawPhaseCharts('phase12',p12,cfg);
      drawPhaseCharts('phase3', p3,cfg);
      updateSummaryTable(p12,p3,cfg);
    });
  }

  // ---------- Global charts ----------
  function renderAllCharts(datasets){
    renderDimensionChart(datasets);
    renderTopNChart('modality-chart','modality',datasets,modalityFilter,8);
    renderTopNChart('task-chart','task',datasets,taskFilter,8);
  }

  function renderDimensionChart(datasets){
    const labels=['2D','3D','video'];
    const counts={ '2D':0,'3D':0,'video':0 };
    datasets.forEach(d=>{
      const f=getDimFlags(d);
      if(f.has2D) counts['2D']++;
      if(f.has3D) counts['3D']++;
      if(f.hasVideo) counts['video']++;
    });
    createOrUpdateDonutChart('dimension-chart',labels,[counts['2D'],counts['3D'],counts['video']],dimensionFilter,{compact:false});
  }

  function renderTopNChart(canvasId,field,datasets,filterElement,topN){
    const allCounts={};
    datasets.forEach(d=> d[field].forEach(v=>{ allCounts[v]=(allCounts[v]||0)+1; }) );
    const sorted=Object.entries(allCounts).sort(([,a],[,b])=>b-a);
    const top=sorted.slice(0,topN), rest=sorted.slice(topN);
    let labels=top.map(([l])=>l), data=top.map(([,c])=>c);
    if(rest.length){ labels.push('Other'); data.push(rest.reduce((s,[,c])=>s+c,0)); }
    createOrUpdateDonutChart(canvasId,labels,data,filterElement,{compact:false});
  }

  // Doughnut + click highlight
  function createOrUpdateDonutChart(canvasId,labels,data,filterElement,{compact=false}={}){
    const canvas=document.getElementById(canvasId); if(!canvas) return;
    if(charts[canvasId]) charts[canvasId].destroy();
    const ctx=canvas.getContext('2d');
    const clickedIndex=chartClickState[canvasId];
    if(compact){ canvas.style.maxHeight='220px'; canvas.style.height='220px'; }

    charts[canvasId]=new Chart(ctx,{
      type:'doughnut',
      data:{ labels, datasets:[{
        data,
        backgroundColor: PALETTE.slice(0,Math.max(data.length,1)),
        borderColor:'#fff', borderWidth:2, hoverOffset:16,
        offset:(c)=> (clickedIndex!=null && c.dataIndex===clickedIndex)? 20 : 0
      }]},
      options:{
        cutout:'60%',
        responsive:true, maintainAspectRatio:!compact?true:false,
        plugins:{ legend:{display:true,position:'bottom'}, tooltip:{enabled:true} },
        onClick:(evt,active,chart)=>{
          if(!active || !active.length) return;
          const idx=active[0].index; const label=chart.data.labels[idx];
          chartClickState[canvasId]=idx; chart.update();
          if(filterElement){
            filterElement.value = (label==='Other') ? '' : label;
            applyFilters();
            document.getElementById('filters')?.scrollIntoView({behavior:'smooth'});
          }
        }
      }
    });
  }

  function createOrUpdateBarChart(canvasId,labels,data){
    const canvas=document.getElementById(canvasId); if(!canvas) return;
    if(charts[canvasId]) charts[canvasId].destroy();
    const ctx=canvas.getContext('2d');
    canvas.style.maxHeight='220px'; canvas.style.height='220px';
    charts[canvasId]=new Chart(ctx,{
      type:'bar',
      data:{ labels, datasets:[{ data, backgroundColor:PALETTE.slice(0,Math.max(data.length,1)), borderRadius:6 }]},
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{enabled:true} },
        scales:{ x:{grid:{display:false},ticks:{maxRotation:25,minRotation:25}}, y:{grid:{color:'rgba(0,0,0,.06)'},ticks:{precision:0}} }
      }
    });
  }

  // ---------- Phase 1&2 / 3 ----------
  function runPhase12(datasets,cfg){
    const wantDim = cfg.dimension ? String(cfg.dimension).toLowerCase() : null;
    const wantMods = Array.isArray(cfg.modalities)? cfg.modalities.map(s=>String(s).toLowerCase()):null;
    const wantTasks= Array.isArray(cfg.task_types)? cfg.task_types.map(s=>String(s).toLowerCase()):null;

    const allowLic = Array.isArray(cfg.license_allowlist)? cfg.license_allowlist.map(s=>String(s).toLowerCase()):null;
    const includeUnlabeled = cfg.include_unlabeled !== false;
    const minImages = Number.isFinite(+cfg.min_valid_image_n_per_dataset)? +cfg.min_valid_image_n_per_dataset : null;
    const anatomyWL = Array.isArray(cfg.anatomy_whitelist)? cfg.anatomy_whitelist.map(s=>String(s).toLowerCase()):null;
    const releaseMin = cfg.release_date_min ? getYear(cfg.release_date_min) : null;
    const allow3dAs2d = cfg.allow_3d_as_2d_sources === true;

    return datasets.filter(d=>{
      // dimension
      if(wantDim){
        const f=getDimFlags(d);
        if(wantDim==='2d'   && !(f.has2D || (allow3dAs2d && f.has3D))) return false;
        if(wantDim==='3d'   && !f.has3D) return false;
        if(wantDim==='video'&& !f.hasVideo) return false;
      }

      // modality / task
      if(wantMods && wantMods.length){
        const mods=d.modality.map(x=>String(x).toLowerCase());
        if(!intersectNonEmpty(mods,wantMods)) return false;
      }
      if(wantTasks && wantTasks.length){
        const tasks=d.task.map(x=>String(x).toLowerCase());
        if(!intersectNonEmpty(tasks,wantTasks)) return false;
      }

      // license
      if(allowLic && allowLic.length){
        const lic=String(d.license||'').toLowerCase();
        if(!allowLic.includes(lic)) return false;
      }

      // unlabeled
      if(!includeUnlabeled && d.task.length===0) return false;

      // images
      if(minImages!=null && !(d.data_volume_total>=minImages)) return false;

      // anatomy
      if(anatomyWL && anatomyWL.length){
        const organ=String(d.organ||'').toLowerCase();
        if(!anatomyWL.some(a=>organ.includes(a))) return false;
      }

      // release year
      if(releaseMin!=null){ const y=getYear(d.year); if(y==null || y<releaseMin) return false; }

      return true;
    });
  }

  function runPhase3(p12,cfg,forceEnable=false){
    const sel=cfg.selection||{}; const enable=forceEnable || sel.enable===true;
    if(!enable) return p12.slice();

    const minDatasets = Number.isFinite(+sel.min_datasets_per_modality)? +sel.min_datasets_per_modality : 0;
    const minOrgs     = Number.isFinite(+sel.min_orgs_per_modality)? +sel.min_orgs_per_modality : 0;
    const allowedMods = Array.isArray(cfg.modalities)? new Set(cfg.modalities.map(String)) : null;

    const agg={}; // modality -> {datasets:Set, orgs:Set}
    p12.forEach(d=>{
      const org=d.organization||'Unknown';
      d.modality.forEach(m=>{
        if(allowedMods && !allowedMods.has(String(m))) return;
        (agg[m] ||= {datasets:new Set(),orgs:new Set()});
        agg[m].datasets.add(d.name); agg[m].orgs.add(org);
      });
    });

    const keep=new Set( Object.entries(agg).filter(([,v])=>v.datasets.size>=minDatasets && v.orgs.size>=minOrgs).map(([k])=>k) );
    return p12.filter(d=> d.modality.some(m=>keep.has(String(m))) );
  }

  // ---------- Phase charts & summary ----------
  function drawPhaseCharts(tag,dataArr,cfg){
    const wantMods = Array.isArray(cfg?.modalities)? cfg.modalities.map(s=>String(s).toLowerCase()) : null;
    const wantTasks= Array.isArray(cfg?.task_types)? cfg.task_types.map(s=>String(s).toLowerCase()) : null;

    const modCounts={}, taskCounts={};
    dataArr.forEach(d=>{
      d.modality.filter(m=>!wantMods || wantMods.includes(String(m).toLowerCase()))
                .forEach(m=>{ modCounts[m]=(modCounts[m]||0)+1; });
      d.task.filter(t=>!wantTasks || wantTasks.includes(String(t).toLowerCase()))
            .forEach(t=>{ taskCounts[t]=(taskCounts[t]||0)+1; });
    });

    const modLabels=Object.keys(modCounts), modData=modLabels.map(l=>modCounts[l]);
    const taskLabels=Object.keys(taskCounts), taskData=taskLabels.map(l=>taskCounts[l]);

    if(tag==='phase12'){
      if(canvasPhase12Bar) createOrUpdateBarChart('phase12-modality-bar',modLabels,modData);
      if(canvasPhase12Pie) createOrUpdateDonutChart('phase12-task-pie',taskLabels,taskData,null,{compact:true});
    }else if(tag==='phase3'){
      if(canvasPhase3Bar)  createOrUpdateBarChart('phase3-modality-bar',modLabels,modData);
      if(canvasPhase3Pie)  createOrUpdateDonutChart('phase3-task-pie',taskLabels,taskData,null,{compact:true});
    }
  }

  function updateSummaryTable(p12Arr,p3Arr,cfg){
    if(!statsBody) return;
    const allowedMods = Array.isArray(cfg?.modalities)? new Set(cfg.modalities.map(String)) : null;

    const allByMod={};
    p12Arr.forEach(d=>{
      d.modality.forEach(m=>{
        if(allowedMods && !allowedMods.has(String(m))) return;
        (allByMod[m] ||= {datasets:new Set(), images:0, orgs:new Set()});
        allByMod[m].datasets.add(d.name);
        allByMod[m].images += Number.isFinite(d.data_volume_total)? d.data_volume_total : 0;
        allByMod[m].orgs.add(d.organization||'Unknown');
      });
    });

    const selByMod={};
    p3Arr.forEach(d=>{
      d.modality.forEach(m=>{
        if(allowedMods && !allowedMods.has(String(m))) return;
        (selByMod[m] ||= {datasets:new Set()});
        selByMod[m].datasets.add(d.name);
      });
    });

    const rows=Object.keys(allByMod).map(m=>{
      const a=allByMod[m], allCnt=a.datasets.size, imgs=a.images, orgs=a.orgs.size;
      const selCnt=selByMod[m]?.datasets.size ?? allCnt;
      const ratio = allCnt>0 ? (selCnt/allCnt) : 0;
      return { modality:m, datasets:allCnt, images:imgs, orgs, ratio };
    }).sort((x,y)=>y.datasets-x.datasets);

    statsBody.innerHTML='';
    const frag=document.createDocumentFragment();
    rows.forEach(r=>{
      const tr=document.createElement('tr');
      const tdM=document.createElement('td'); tdM.textContent=r.modality;
      const tdD=document.createElement('td'); tdD.textContent=r.datasets.toLocaleString();
      const tdI=document.createElement('td'); tdI.textContent=r.images.toLocaleString();
      const tdO=document.createElement('td'); tdO.textContent=r.orgs.toLocaleString();
      const tdR=document.createElement('td'); tdR.textContent=r.ratio.toFixed(3);
      [tdM,tdD,tdI,tdO,tdR].forEach(td=>tr.appendChild(td)); frag.appendChild(tr);
    });
    statsBody.appendChild(frag);
  }

  // ---------- Kickoff ----------
  fetchData();
});

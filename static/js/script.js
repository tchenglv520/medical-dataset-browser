document.addEventListener('DOMContentLoaded', () => {
  // ===== Data source (static-first fallback) =====
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
      } catch (e) {}
    }
    throw new Error('No available dataset source found.');
  }

  // ===== Global state =====
  let allDatasets = [];
  let baseDatasets = [];           // Base for the table: either all or JSON-filtered
  let currentFilteredData = [];    // baseDatasets + quick filters
  const charts = {};
  const chartClickState = {};
  let baseLabel = 'All datasets';  // shown in the banner as the source
  let activeMode = 'none';         // 'mode1' or 'mode2' or 'none'
  let lastJsonCfg = null;          // keep last JSON config to align counts with Summary table

  // Infinite scroll
  let currentPage = 1;
  const itemsPerPage = 100;
  let isLoading = false;

  // DOM
  const tableBody = document.getElementById('table-body');
  const searchBox = document.getElementById('search-box');
  const dimensionFilter = document.getElementById('dimension-filter');
  const modalityFilter = document.getElementById('modality-filter');
  const taskFilter = document.getElementById('task-filter');
  const includeMixedDim = document.getElementById('include-mixed-dim');
  const noResultsDiv = document.getElementById('no-results');
  const loadingIndicator = document.getElementById('loading-indicator');
  const resultsCount = document.getElementById('results-count');

  // JSON panel
  const jsonTextarea = document.getElementById('filter-json');
  const btnPhase12 = document.getElementById('btn-apply-phase12');
  const btnPhase34 = document.getElementById('btn-apply-phase3'); // "Run Phase 3&4"
  const btnClearMode1 = document.getElementById('btn-clear-mode1');
  const btnClearMode2 = document.getElementById('btn-clear-mode2');
  const jsonError  = document.getElementById('json-error');

  // Phase canvases
  const canvasPhase12Bar  = document.getElementById('phase12-modality-bar');
  const canvasPhase3Bar   = document.getElementById('phase3-modality-bar');
  const canvasPhase12Pie  = document.getElementById('phase12-task-pie');
  const canvasPhase3Pie   = document.getElementById('phase3-task-pie');

  // Phase 4 table body
  const statsBody = document.getElementById('stats-body');

  // ===== Utils =====
  const PALETTE = [
    '#0d6efd', '#6f42c1', '#d63384', '#fd7e14', '#ffc107',
    '#198754', '#20c997', '#0dcaf0', '#6c757d', '#adb5bd'
  ];

  function toArray(v) {
    if (Array.isArray(v)) return v;
    if (v == null) return [];
    return [v];
  }

  function sanitizeNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'string') {
      const n = Number(value.replace(/[^\d.-]/g, ''));
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  function getYear(y) {
    if (!y) return null;
    const n = Number(String(y).slice(0, 4));
    return Number.isFinite(n) ? n : null;
  }

  function intersectNonEmpty(a, b) {
    if (!a || !b) return false;
    const setB = new Set(b.map(x => String(x).toLowerCase()));
    return a.some(x => setB.has(String(x).toLowerCase()));
  }

  function readFilterJson() {
    if (!jsonTextarea) return null;
    if (jsonError) jsonError.textContent = '';
    try {
      return JSON.parse(jsonTextarea.value);
    } catch (e) {
      if (jsonError) jsonError.textContent = 'Invalid JSON: ' + e.message;
      return null;
    }
  }

  // ===== Data fetch & init =====
  async function fetchData() {
    try {
      const { url, json } = await fetchFirstAvailable(DATA_URLS);
      const raw = Array.isArray(json) ? json : (Array.isArray(json?.rows) ? json.rows : []);
      if (!Array.isArray(raw)) throw new Error('Unexpected dataset format from ' + url);

      allDatasets = raw.map(d => ({
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
    } catch (err) {
      console.error('Failed to load datasets:', err);
      if (tableBody) {
        tableBody.innerHTML = `<tr><td colspan="10" class="text-center text-danger">Data load failed</td></tr>`;
      }
    }
  }

  function initialize() {
    if (!allDatasets.length) {
      noResultsDiv?.classList.remove('d-none');
      return;
    }
    populateFiltersFromBase();
    renderAllCharts(allDatasets);
    setupEventListeners();
    applyFilters(); // first paint
  }

  // ===== Quick filters (dropdowns) =====
  function countFieldInBase(field) {
    const counts = {};
    baseDatasets.forEach(d => {
      toArray(d[field]).forEach(v => {
        counts[v] = (counts[v] || 0) + 1;
      });
    });
    return counts;
  }

  function populateFiltersFromBase() {
    const modCounts = countFieldInBase('modality');
    const taskCounts = countFieldInBase('task');
    fillSelectSorted(modalityFilter, modCounts, 'Modality');
    fillSelectSorted(taskFilter, taskCounts, 'Task');
  }

  function fillSelectSorted(selectEl, countsObj, placeholder) {
    if (!selectEl) return;
    const current = selectEl.value;
    selectEl.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = placeholder;
    selectEl.appendChild(ph);

    const entries = Object.entries(countsObj)
      .sort((a, b) => b[1] - a[1])
      .map(([label]) => label);

    entries.forEach(option => {
      const opt = document.createElement('option');
      opt.value = option;
      opt.textContent = option;
      selectEl.appendChild(opt);
    });

    if (current && entries.includes(current)) {
      selectEl.value = current;
    }
  }

  // ===== Table rendering =====
  function appendRowsToTable(datasets) {
    if (!tableBody) return;
    const frag = document.createDocumentFragment();

    datasets.forEach(d => {
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      const strong = document.createElement('strong');
      strong.textContent = d.name || 'N/A';
      tdName.appendChild(strong);

      const tdDim = document.createElement('td');
      const spanDim = document.createElement('span');
      spanDim.className = 'badge bg-secondary';
      spanDim.textContent = d.dimension.length ? d.dimension.join(', ') : 'N/A';
      tdDim.appendChild(spanDim);

      const tdMod = document.createElement('td'); tdMod.textContent = d.modality.length ? d.modality.join(', ') : 'N/A';
      const tdTask= document.createElement('td'); tdTask.textContent = d.task.length ? d.task.join(', ') : 'N/A';
      const tdOrg = document.createElement('td'); tdOrg.textContent = d.organ || 'N/A';
      const tdNum = document.createElement('td'); tdNum.textContent = Number.isFinite(d.data_volume_total) ? d.data_volume_total.toLocaleString() : 'N/A';
      const tdYear= document.createElement('td'); tdYear.textContent = d.year || 'N/A';
      const tdChal= document.createElement('td'); tdChal.textContent = d.organization || 'N/A';
      const tdLic = document.createElement('td'); tdLic.textContent = d.license || 'N/A';

      const tdLink = document.createElement('td');
      if (d.link) {
        try {
          const url = new URL(d.link, location.href);
          if (url.protocol === 'http:' || url.protocol === 'https:') {
            const a = document.createElement('a');
            a.href = url.href;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = 'Access';
            tdLink.appendChild(a);
          } else {
            tdLink.textContent = 'N/A';
          }
        } catch {
          tdLink.textContent = 'N/A';
        }
      } else {
        tdLink.textContent = 'N/A';
      }

      [tdName, tdDim, tdMod, tdTask, tdOrg, tdNum, tdYear, tdChal, tdLic, tdLink].forEach(td => tr.appendChild(td));
      frag.appendChild(tr);
    });

    tableBody.appendChild(frag);
  }

  // ===== Infinite scroll =====
  function loadMoreData() {
    if (isLoading) return;

    const start = (currentPage - 1) * itemsPerPage;
    const end = start + itemsPerPage;

    if (start >= currentFilteredData.length) {
      loadingIndicator?.classList.add('d-none');
      return;
    }

    isLoading = true;
    loadingIndicator?.classList.remove('d-none');

    setTimeout(() => {
      const nextPageData = currentFilteredData.slice(start, end);
      appendRowsToTable(nextPageData);
      currentPage++;
      isLoading = false;
      loadingIndicator?.classList.add('d-none');
    }, 150);
  }

  // ===== Helpers for banner–summary consistency =====
  // Count with the same logic as Summary Table:
  // - per-modality unique-by-name
  // - totals are the sum across modalities (no cross-modality dedupe)
  function computeSummaryLikeTotals(rows, cfg) {
    const allowedMods = Array.isArray(cfg?.modalities)
      ? new Set(cfg.modalities.map(String))
      : null;

    const byMod = {}; // mod => {names:Set, images:number}
    rows.forEach(d => {
      d.modality.forEach(m => {
        const mod = String(m);
        if (allowedMods && !allowedMods.has(mod)) return;
        if (!byMod[mod]) byMod[mod] = { names: new Set(), images: 0 };
        byMod[mod].names.add(d.name || '(unknown)');
        byMod[mod].images += Number.isFinite(d.data_volume_total) ? d.data_volume_total : 0;
      });
    });

    let datasetTotal = 0;
    let imagesTotal = 0;
    Object.values(byMod).forEach(v => {
      datasetTotal += v.names.size;
      imagesTotal  += v.images;
    });
    return { datasetTotal, imagesTotal };
  }

  // ===== Quick filter logic =====
  function applyFilters() {
    const searchTerm = (searchBox?.value || '').toLowerCase().trim();
    const selectedDimension = dimensionFilter?.value || '';
    const selectedModality  = modalityFilter?.value || '';
    const selectedTask      = taskFilter?.value || '';
    const allowMixed        = !!(includeMixedDim && includeMixedDim.checked);

    const source = baseDatasets.length ? baseDatasets : allDatasets;

    currentFilteredData = source.filter(d => {
      const matchesSearch =
        !searchTerm ||
        (d.name && d.name.toLowerCase().includes(searchTerm)) ||
        (d.organization && d.organization.toLowerCase().includes(searchTerm)) ||
        (d.organ && d.organ.toLowerCase().includes(searchTerm));

      let matchesDimension = true;
      if (selectedDimension) {
        const dims = d.dimension.map(x => String(x).toLowerCase());
        const normalize = new Set();
        if (dims.some(x => x.includes('2d'))) normalize.add('2d');
        if (dims.some(x => x.includes('3d'))) normalize.add('3d');
        if (dims.some(x => x.includes('video'))) normalize.add('video');

        const want = selectedDimension.toLowerCase();
        if (allowMixed) {
          matchesDimension = normalize.has(want);
        } else {
          matchesDimension = (normalize.size === 1 && normalize.has(want));
        }
      }

      const matchesModality  = !selectedModality  || d.modality.includes(selectedModality);
      const matchesTask      = !selectedTask      || d.task.includes(selectedTask);

      return matchesSearch && matchesDimension && matchesModality && matchesTask;
    });

    // Reset and render table
    tableBody.innerHTML = '';
    currentPage = 1;

    // ==== Banner text ====
    let bannerText = '';
    if (activeMode === 'mode1') {
      // JSON mode: follow Summary Table counting logic (guaranteed consistent)
      const { datasetTotal, imagesTotal } = computeSummaryLikeTotals(baseDatasets, lastJsonCfg);
      bannerText =
        datasetTotal > 0
          ? `Found ${datasetTotal} datasets, with approximately ${imagesTotal.toLocaleString()} images in total. [via: ${baseLabel}]`
          : `Found 0 matching datasets. [via: ${baseLabel}]`;
    } else {
      // Quick filters: count rows, sum images by rows
      const rowCount = currentFilteredData.length;
      const imagesSum = currentFilteredData.reduce((s, ds) => {
        return s + (Number.isFinite(ds.data_volume_total) ? ds.data_volume_total : 0);
      }, 0);
      const anyQuick = !!searchTerm || !!selectedDimension || !!selectedModality || !!selectedTask || !allowMixed;
      const via = anyQuick ? `${baseLabel} + Quick filters` : baseLabel;

      bannerText =
        rowCount > 0
          ? `Found ${rowCount} datasets, with approximately ${imagesSum.toLocaleString()} images in total. [via: ${via}]`
          : `Found 0 matching datasets. [via: ${via}]`;
    }

    resultsCount.textContent = bannerText;
    noResultsDiv?.classList.toggle('d-none', currentFilteredData.length > 0);

    // Keep global charts in sync with what's visible
    renderAllCharts(currentFilteredData.length ? currentFilteredData : allDatasets);

    loadMoreData();
  }

  // ===== Mode clear helpers =====
  function clearMode2Filters() {
    if (searchBox) searchBox.value = '';
    if (dimensionFilter) dimensionFilter.value = '';
    if (modalityFilter) modalityFilter.value = '';
    if (taskFilter) taskFilter.value = '';
    if (includeMixedDim) includeMixedDim.checked = true;
  }

  function destroyChart(id) {
    if (charts[id]) {
      try { charts[id].destroy(); } catch {}
      delete charts[id];
    }
  }

  function clearPhaseOutputs() {
    destroyChart('phase12-modality-bar');
    destroyChart('phase12-task-pie');
    destroyChart('phase3-modality-bar');
    destroyChart('phase3-task-pie');
    if (statsBody) statsBody.innerHTML = '';
  }

  function switchToMode2IfNeeded() {
    if (activeMode !== 'mode2') {
      // Clear Mode 1 effects and return to all datasets
      baseDatasets = allDatasets.slice();
      baseLabel = 'All datasets';
      lastJsonCfg = null;
      jsonTextarea?.classList.remove('phase12-running', 'phase34-running');
      clearPhaseOutputs();
      populateFiltersFromBase(); // resort options against all
      activeMode = 'mode2';
    }
  }

  function switchToMode1() {
    // When using Mode 1, automatically clear Mode 2 filters
    clearMode2Filters();
    activeMode = 'mode1';
  }

  // ===== Event listeners =====
  function setupEventListeners() {
    // Quick filters — on first interaction, auto switch to Mode 2 (and clear Mode 1)
    const quickInputs = [searchBox, dimensionFilter, includeMixedDim, modalityFilter, taskFilter];
    quickInputs.forEach(el => {
      el?.addEventListener('input', () => { switchToMode2IfNeeded(); applyFilters(); });
      el?.addEventListener('change', () => { switchToMode2IfNeeded(); applyFilters(); });
    });

    window.addEventListener('scroll', () => {
      if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500) {
        loadMoreData();
      }
    });

    // JSON-driven phases
    btnPhase12?.addEventListener('click', () => {
      const cfg = readFilterJson();
      if (!cfg) return;

      switchToMode1();
      lastJsonCfg = cfg;

      jsonTextarea.classList.add('phase12-running');
      jsonTextarea.classList.remove('phase34-running');

      const p12 = runPhase12(allDatasets, cfg);

      baseDatasets = p12.slice();
      baseLabel = 'JSON Phase 1&2';

      populateFiltersFromBase();
      applyFilters();

      drawPhaseCharts('phase12', p12, cfg);
      updateSummaryTable(p12, p12, cfg);
    });

    btnPhase34?.addEventListener('click', () => {
      const cfg = readFilterJson();
      if (!cfg) return;

      switchToMode1();
      lastJsonCfg = cfg;

      jsonTextarea.classList.remove('phase12-running');
      jsonTextarea.classList.add('phase34-running');

      const p12 = runPhase12(allDatasets, cfg);
      const p3  = runPhase3(p12, cfg, true);

      baseDatasets = p3.slice();
      baseLabel = 'JSON Phase 3&4';

      populateFiltersFromBase();
      applyFilters();

      drawPhaseCharts('phase12', p12, cfg);
      drawPhaseCharts('phase3',  p3,  cfg);
      updateSummaryTable(p12, p3, cfg);
    });

    // Clear buttons
    btnClearMode1?.addEventListener('click', () => {
      // Clear Mode 1 effects and return to All datasets
      jsonTextarea?.classList.remove('phase12-running', 'phase34-running');
      baseDatasets = allDatasets.slice();
      baseLabel = 'All datasets';
      lastJsonCfg = null;
      clearPhaseOutputs();
      populateFiltersFromBase();
      activeMode = 'none';
      applyFilters();
    });

    btnClearMode2?.addEventListener('click', () => {
      clearMode2Filters();
      // If not in Mode 2, restore All datasets baseline
      if (activeMode !== 'mode2') {
        baseDatasets = allDatasets.slice();
        baseLabel = 'All datasets';
        lastJsonCfg = null;
        jsonTextarea?.classList.remove('phase12-running', 'phase34-running');
        clearPhaseOutputs();
        populateFiltersFromBase();
        activeMode = 'mode2';
      }
      applyFilters();
    });
  }

  // ===== Global charts (dimension/modality/task) =====
  function renderAllCharts(datasets) {
    renderDimensionChart(datasets);
    renderTopNChart('modality-chart', 'modality', datasets, modalityFilter, 8);
    renderTopNChart('task-chart', 'task', datasets, taskFilter, 8);
  }

  function renderDimensionChart(datasets) {
    const canvasId = 'dimension-chart';
    const labels = ['2D', '3D', 'video'];
    const counts = { '2D': 0, '3D': 0, 'video': 0 };

    datasets.forEach(d => {
      const dims = d.dimension.map(x => String(x).toLowerCase());
      if (dims.some(dim => dim.includes('2d'))) counts['2D']++;
      if (dims.some(dim => dim.includes('3d'))) counts['3D']++;
      if (dims.some(dim => dim.includes('video'))) counts['video']++;
    });

    const data = labels.map(l => counts[l]);
    createOrUpdateDonutChart(canvasId, labels, data, dimensionFilter, {
      compact: false,
      onBeforeApplyFilter: () => {
        if (includeMixedDim) includeMixedDim.checked = true;
      }
    });
  }

  function renderTopNChart(canvasId, field, datasets, filterElement, topN) {
    const allCounts = {};
    datasets.forEach(d => {
      d[field].forEach(val => {
        allCounts[val] = (allCounts[val] || 0) + 1;
      });
    });

    const sorted = Object.entries(allCounts).sort(([, a], [, b]) => b - a);
    const topItems = sorted.slice(0, topN);
    const otherItems = sorted.slice(topN);

    let labels = topItems.map(([label]) => label);
    let data   = topItems.map(([, count]) => count);

    if (otherItems.length > 0) {
      labels.push('Other');
      data.push(otherItems.reduce((sum, [, count]) => sum + count, 0));
    }

    createOrUpdateDonutChart(canvasId, labels, data, filterElement, { compact: false });
  }

  // ===== Charts: doughnut with click highlight =====
  function createOrUpdateDonutChart(canvasId, labels, data, filterElement, { compact = false, onBeforeApplyFilter = null } = {}) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    if (charts[canvasId]) charts[canvasId].destroy();
    const ctx = canvas.getContext('2d');
    const clickedIndex = chartClickState[canvasId];

    if (compact) {
      canvas.style.maxHeight = '220px';
      canvas.style.height = '220px';
    }

    charts[canvasId] = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: PALETTE.slice(0, Math.max(data.length, 1)),
          borderColor: '#ffffff',
          borderWidth: 2,
          hoverOffset: 16,
          offset: (cxt) => {
            const idx = cxt.dataIndex;
            return (clickedIndex != null && idx === clickedIndex) ? 20 : 0;
          }
        }]
      },
      options: {
        cutout: '60%',
        responsive: true,
        maintainAspectRatio: !compact ? true : false,
        plugins: {
          legend: { display: true, position: 'bottom' },
          tooltip: { enabled: true }
        },
        animation: { animateRotate: true, animateScale: true },
        onClick: (event, activeEls, chart) => {
          if (!activeEls || activeEls.length === 0) return;
          const idx = activeEls[0].index;
          const clickedLabel = chart.data.labels[idx];

          chartClickState[canvasId] = idx;
          chart.update();

          if (filterElement) {
            if (onBeforeApplyFilter) onBeforeApplyFilter();
            filterElement.value = (clickedLabel === 'Other') ? '' : clickedLabel;
            switchToMode2IfNeeded(); // clicking overview chart implies using quick filters
            applyFilters();
            document.getElementById('filters')?.scrollIntoView({ behavior: 'smooth' });
          }
        }
      }
    });
  }

  function createOrUpdateBarChart(canvasId, labels, data) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    if (charts[canvasId]) charts[canvasId].destroy();
    const ctx = canvas.getContext('2d');

    canvas.style.maxHeight = '220px';
    canvas.style.height = '220px';

    charts[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: PALETTE.slice(0, Math.max(data.length, 1)),
          borderWidth: 0,
          borderRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { enabled: true }
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 25, minRotation: 25 } },
          y: { grid: { color: 'rgba(0,0,0,.06)' }, ticks: { precision: 0 } }
        }
      }
    });
  }

  // ===== Phase 1&2 and Phase 3 logic =====
  function runPhase12(datasets, cfg) {
    const wantedDimension  = cfg.dimension ? String(cfg.dimension).toLowerCase() : null;
    const wantedModalities = Array.isArray(cfg.modalities) ? cfg.modalities.map(s => String(s).toLowerCase()) : null;
    const wantedTasks      = Array.isArray(cfg.task_types) ? cfg.task_types.map(s => String(s).toLowerCase()) : null;

    const licenseAllow     = Array.isArray(cfg.license_allowlist) ? cfg.license_allowlist.map(s => String(s).toLowerCase()) : null;
    const includeUnlabeled = cfg.include_unlabeled !== false; // default true
    const minImages        = Number.isFinite(+cfg.min_valid_image_n_per_dataset) ? +cfg.min_valid_image_n_per_dataset : null;
    const anatomyWhitelist = Array.isArray(cfg.anatomy_whitelist) ? cfg.anatomy_whitelist.map(s => String(s).toLowerCase()) : null;
    const releaseMin       = cfg.release_date_min ? getYear(cfg.release_date_min) : null;
    const allow3dAs2d      = cfg.allow_3d_as_2d_sources === true;

    return datasets.filter(d => {
      if (wantedDimension) {
        const dims = d.dimension.map(x => String(x).toLowerCase());
        const is2D = dims.some(x => x.includes('2d'));
        const is3D = dims.some(x => x.includes('3d'));
        const isVideo = dims.some(x => x.includes('video'));
        if (wantedDimension === '2d') {
          if (!(is2D || (allow3dAs2d && is3D))) return false;
        } else if (wantedDimension === '3d') {
          if (!is3D) return false;
        } else if (wantedDimension === 'video') {
          if (!isVideo) return false;
        }
      }

      if (wantedModalities && wantedModalities.length) {
        const mods = d.modality.map(x => String(x).toLowerCase());
        if (!intersectNonEmpty(mods, wantedModalities)) return false;
      }

      if (wantedTasks && wantedTasks.length) {
        const tasks = d.task.map(x => String(x).toLowerCase());
        if (!intersectNonEmpty(tasks, wantedTasks)) return false;
      }

      if (licenseAllow && licenseAllow.length) {
        const lic = String(d.license || '').toLowerCase();
        if (!licenseAllow.includes(lic)) return false;
      }

      if (!includeUnlabeled && d.task.length === 0) return false;

      if (minImages != null && !(d.data_volume_total >= minImages)) return false;

      if (anatomyWhitelist && anatomyWhitelist.length) {
        const organ = String(d.organ || '').toLowerCase();
        if (!anatomyWhitelist.some(a => organ.includes(a))) return false;
      }

      if (releaseMin != null) {
        const y = getYear(d.year);
        if (y == null || y < releaseMin) return false;
      }

      return true;
    });
  }

  function runPhase3(phase12Datasets, cfg, forceEnable = false) {
    const sel = cfg.selection || {};
    const enable = forceEnable || sel.enable === true;
    if (!enable) return phase12Datasets.slice();

    const minDatasets = Number.isFinite(+sel.min_datasets_per_modality) ? +sel.min_datasets_per_modality : 0;
    const minOrgs     = Number.isFinite(+sel.min_orgs_per_modality) ? +sel.min_orgs_per_modality : 0;

    const allowedMods = Array.isArray(cfg.modalities) ? new Set(cfg.modalities.map(s => String(s))) : null;

    const modalityMap = {};
    phase12Datasets.forEach(d => {
      const org = d.organization || 'Unknown';
      d.modality.forEach(m => {
        if (allowedMods && !allowedMods.has(String(m))) return;
        const key = String(m);
        if (!modalityMap[key]) modalityMap[key] = { datasets: new Set(), orgs: new Set() };
        modalityMap[key].datasets.add(d.name);
        modalityMap[key].orgs.add(org);
      });
    });

    const keepModalities = new Set(
      Object.entries(modalityMap)
        .filter(([, v]) => v.datasets.size >= minDatasets && v.orgs.size >= minOrgs)
        .map(([k]) => k)
    );

    const selected = phase12Datasets.filter(d => d.modality.some(m => keepModalities.has(String(m))));
    return selected;
  }

  // ===== Phase charts (count only JSON-allowed modalities/tasks) =====
  function drawPhaseCharts(tag, dataArr, cfg) {
    const wantedMods = Array.isArray(cfg?.modalities)
      ? cfg.modalities.map(s => String(s).toLowerCase())
      : null;
    const wantedTasks = Array.isArray(cfg?.task_types)
      ? cfg.task_types.map(s => String(s).toLowerCase())
      : null;

    const modCounts = {};
    const taskCounts = {};

    dataArr.forEach(d => {
      const mods = d.modality.filter(m =>
        !wantedMods || wantedMods.includes(String(m).toLowerCase())
      );
      mods.forEach(m => { modCounts[m] = (modCounts[m] || 0) + 1; });

      const tasks = d.task.filter(t =>
        !wantedTasks || wantedTasks.includes(String(t).toLowerCase())
      );
      tasks.forEach(t => { taskCounts[t] = (taskCounts[t] || 0) + 1; });
    });

    const modLabels = Object.keys(modCounts);
    const modData   = modLabels.map(l => modCounts[l]);
    const taskLabels= Object.keys(taskCounts);
    const taskData  = taskLabels.map(l => taskCounts[l]);

    if (tag === 'phase12') {
      if (canvasPhase12Bar) createOrUpdateBarChart('phase12-modality-bar', modLabels, modData);
      if (canvasPhase12Pie) createOrUpdateDonutChart('phase12-task-pie', taskLabels, taskData, null, { compact: true });
    } else if (tag === 'phase3') {
      if (canvasPhase3Bar)  createOrUpdateBarChart('phase3-modality-bar',  modLabels, modData);
      if (canvasPhase3Pie)  createOrUpdateDonutChart('phase3-task-pie',    taskLabels, taskData, null, { compact: true });
    }
  }

  // ===== Phase 4 — Summary Table =====
  function updateSummaryTable(phase12Arr, phase3Arr, cfg) {
    if (!statsBody) return;

    const allowedMods = Array.isArray(cfg?.modalities) ? new Set(cfg.modalities.map(String)) : null;

    const allByMod = {};
    phase12Arr.forEach(d => {
      d.modality.forEach(m => {
        if (allowedMods && !allowedMods.has(String(m))) return;
        const key = String(m);
        (allByMod[key] ||= { datasets: new Set(), images: 0, orgs: new Set() });
        allByMod[key].datasets.add(d.name);
        allByMod[key].images += Number.isFinite(d.data_volume_total) ? d.data_volume_total : 0;
        allByMod[key].orgs.add(d.organization || 'Unknown');
      });
    });

    const selByMod = {};
    phase3Arr.forEach(d => {
      d.modality.forEach(m => {
        if (allowedMods && !allowedMods.has(String(m))) return;
        const key = String(m);
        (selByMod[key] ||= { datasets: new Set() });
        selByMod[key].datasets.add(d.name);
      });
    });

    const rows = Object.keys(allByMod).map(mod => {
      const all = allByMod[mod];
      const allDatasetsCount = all.datasets.size;
      const allImages = all.images;
      const allOrgs = all.orgs.size;
      const selCount = selByMod[mod]?.datasets.size ?? allDatasetsCount;
      const ratio = allDatasetsCount > 0 ? (selCount / allDatasetsCount) : 0;
      return { modality: mod, datasets: allDatasetsCount, images: allImages, orgs: allOrgs, ratio };
    });

    rows.sort((a, b) => b.datasets - a.datasets);

    statsBody.innerHTML = '';
    const frag = document.createDocumentFragment();
    rows.forEach(r => {
      const tr = document.createElement('tr');
      const tdM = document.createElement('td'); tdM.textContent = r.modality;
      const tdD = document.createElement('td'); tdD.textContent = r.datasets.toLocaleString();
      const tdI = document.createElement('td'); tdI.textContent = r.images.toLocaleString();
      const tdO = document.createElement('td'); tdO.textContent = r.orgs.toLocaleString();
      const tdR = document.createElement('td'); tdR.textContent = r.ratio.toFixed(3);
      [tdM, tdD, tdI, tdO, tdR].forEach(td => tr.appendChild(td));
      frag.appendChild(tr);
    });
    statsBody.appendChild(frag);
  }

  // ===== Global charts renderers =====
  function renderAllCharts(datasets) {
    renderDimensionChart(datasets);
    renderTopNChart('modality-chart', 'modality', datasets, modalityFilter, 8);
    renderTopNChart('task-chart', 'task', datasets, taskFilter, 8);
  }

  // ===== Kickoff =====
  fetchData();
});

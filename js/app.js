// app.js - Main application controller
import { GPXParser } from './gpxParser.js';
import { SpeedModel } from './speedModel.js';
import { Simulation } from './simulation.js';
import { Aggregation } from './aggregation.js';

// ===== DEFAULT ROUTE CONFIGURATIONS =====
const DEFAULT_ROUTES = [
    { name: 'Geronimo 37', miles: 37, riders: 151, color: '#a78bfa', gpxFile: '2026-routes/Geronimo_-_2026_Marin_Century_-_Official_Route (2).gpx' },
    { name: 'Metric Century 64', miles: 64, riders: 878, color: '#f59e0b', gpxFile: '2026-routes/Metric_Century_-_2026_Marin_Century_-_Official_Route.gpx' },
    { name: 'Century 100', miles: 100, riders: 795, color: '#10b981', gpxFile: '2026-routes/Century_-_2026_Marin_Century_-_Official_Route.gpx' },
    { name: 'Mt Tam 93', miles: 93, riders: 258, color: '#3b82f6', gpxFile: '2026-routes/Mt._Tam_-_2026_Marin_Century_Official_Route.gpx' },
    { name: 'Double Metric 127', miles: 127, riders: 117, color: '#facc15', gpxFile: '2026-routes/Double_Metric_-_Marin_Century_2026_-_Official_Route.gpx' },
];

const DEFAULT_SPEED_TIERS = [17, 15, 13.5, 12, 10];
const DEFAULT_TIER_WEIGHTS = [0.05, 0.20, 0.50, 0.20, 0.05];
const TIER_NAMES = ['max', 'upper', 'mid', 'lower', 'min'];
const DEFAULT_DWELL_TIMES = { max: 5, upper: 7, mid: 10, lower: 12, min: 12 };

// ===== APPLICATION STATE =====
const state = {
    routes: DEFAULT_ROUTES.map(r => ({
        ...r,
        gpxLoaded: false,
        parsedRoute: null,
        noShowRate: 0.10,
        speedTiers: [...DEFAULT_SPEED_TIERS],
        startTimes: [], // will be initialized with default slots
        restStops: [],
        policePoints: [],
    })),
    tierWeights: [...DEFAULT_TIER_WEIGHTS],
    speedModel: {
        uphillFactor: 1.0,
        downhillFactor: 0.5,
        minSpeed: 3,
        maxSpeed: 30,
    },
    weather: {
        factor: 0,
        startHour: 12,
    },
    simulationResults: null,
    aggregatedResults: null,
    aggregatedPolice: null,
    defaultDwellTimes: { ...DEFAULT_DWELL_TIMES },
};

// Initialize default start times for each route
function initDefaultStartTimes() {
    const presets = {
        'Geronimo 37': [
            { hour: 8.0, percentage: 0.30 }, { hour: 8.5, percentage: 0.40 },
            { hour: 9.0, percentage: 0.30 }
        ],
        'Metric Century 64': [
            { hour: 7.0, percentage: 0.35 }, { hour: 7.5, percentage: 0.30 },
            { hour: 8.0, percentage: 0.25 }, { hour: 8.5, percentage: 0.10 }
        ],
        'Century 100': [
            { hour: 6.5, percentage: 0.10 }, { hour: 7.0, percentage: 0.40 },
            { hour: 7.5, percentage: 0.35 }, { hour: 8.0, percentage: 0.15 }
        ],
        'Mt Tam 93': [
            { hour: 6.5, percentage: 0.15 }, { hour: 7.0, percentage: 0.40 },
            { hour: 7.5, percentage: 0.35 }, { hour: 8.0, percentage: 0.10 }
        ],
        'Double Metric 127': [
            { hour: 6.0, percentage: 0.30 }, { hour: 6.5, percentage: 0.50 },
            { hour: 7.0, percentage: 0.20 }
        ],
    };

    state.routes.forEach(route => {
        route.startTimes = presets[route.name] || [
            { hour: 7.0, percentage: 0.50 },
            { hour: 7.5, percentage: 0.30 },
            { hour: 8.0, percentage: 0.20 }
        ];
    });
}

// ===== MODULES =====
const gpxParser = new GPXParser();
let speedModel = new SpeedModel(state.speedModel);
const simulation = new Simulation(speedModel);
const aggregation = new Aggregation(30); // 30-minute resolution

// ===== INITIALIZATION =====
document.addEventListener('DOMContentLoaded', () => {
    initDefaultStartTimes();
    initTabs();
    renderRouteCards();
    renderRidersTab();
    renderSettingsTab();
    bindHeaderActions();
    updateStatusBar();
    
    // Auto-load config if it exists, otherwise preload default GPX files
    autoLoadConfig().then(configLoaded => {
        if (!configLoaded) {
            preloadGPXFiles();
        }
    });
});

// ===== DATA PRELOADING =====
async function preloadGPXFiles() {
    let loadedCount = 0;
    for (let i = 0; i < state.routes.length; i++) {
        const route = state.routes[i];
        if (route.gpxFile && !route.gpxLoaded) {
            try {
                const response = await fetch(encodeURI(route.gpxFile));
                if (response.ok) {
                    const xmlText = await response.text();
                    const parsed = gpxParser.parseXML(xmlText);
                    route.parsedRoute = parsed;
                    route.gpxLoaded = true;
                    route.gpxRawXml = xmlText;

                    // GPX wins: use GPX names/locations but preserve saved dwell times
                    route.restStops = overlayDwellTimes(parsed.restStops, route.restStopsFromConfig || []);
                    delete route.restStopsFromConfig;

                    route.policePoints = parsed.policeStops || [];
                    loadedCount++;
                }
            } catch (err) {
                console.warn(`Could not auto-load GPX for ${route.name}:`, err);
            }
        }
    }

    if (loadedCount > 0) {
        state.simulationResults = null;
        renderRouteCards();
        updateStatusBar();
    }
}

/**
 * Apply saved dwell times onto freshly-GPX-parsed rest stops.
 * GPX provides authoritative name/location; config only contributes dwell times.
 * Matches by name (case-insensitive) first, then by mile proximity.
 */
function overlayDwellTimes(gpxStops, savedStops) {
    return gpxStops.map(gpxStop => {
        // Try to find a saved config match by name or mile proximity
        const match = savedStops && (
            savedStops.find(s =>
                s.name.toLowerCase().trim() === gpxStop.name.toLowerCase().trim()
            ) || savedStops.find(s =>
                Math.abs((s.mile || 0) - (gpxStop.mile || 0)) < 1.5
            )
        );
        if (match?.dwellTimes) {
            return { ...gpxStop, dwellTimes: { ...match.dwellTimes } };
        }
        // Fall back to global default dwell times
        return { ...gpxStop, dwellTimes: { ...state.defaultDwellTimes } };
    });
}

const LS_KEY = 'marin-century-config-v3';

function saveToLocalStorage() {
    const config = buildConfigObject();
    try {
        localStorage.setItem(LS_KEY, JSON.stringify(config));
    } catch (e) {
        console.warn('Could not save to localStorage:', e);
    }
}

function buildConfigObject() {
    return {
        version: 3,
        savedAt: new Date().toISOString(),
        routes: state.routes.map(r => ({
            name: r.name,
            miles: r.miles,
            riders: r.riders,
            noShowRate: r.noShowRate,
            speedTiers: r.speedTiers,
            startTimes: r.startTimes,
            restStops: r.restStops,
            color: r.color,
        })),
        tierWeights: state.tierWeights,
        speedModel: state.speedModel,
        weather: state.weather,
        defaultDwellTimes: state.defaultDwellTimes,
    };
}

async function autoLoadConfig() {
    // Check browser localStorage first — most recent user changes live here
    try {
        const stored = localStorage.getItem(LS_KEY);
        if (stored) {
            const config = JSON.parse(stored);
            if (config.version >= 1 && config.version <= 3) {
                applyConfig(config);
                await preloadGPXFiles();
                console.log('Loaded config from browser storage');
                return true;
            }
        }
    } catch (e) {
        console.warn('Could not read localStorage config:', e);
    }

    // Fall back to committed config.json on the server
    try {
        const cacheBuster = new Date().getTime();
        const response = await fetch(`marin-century-config.json?v=${cacheBuster}`);
        if (!response.ok) return false;

        const config = await response.json();
        if (config.version < 1 || config.version > 3) return false;

        applyConfig(config);
        await preloadGPXFiles();
        console.log('Loaded config from server config.json');
        return true;
    } catch (err) {
        console.log('No marin-century-config.json found (using defaults).', err.message);
        return false;
    }
}

/**
 * Apply a config object to state and update all UI elements.
 * Used by both localStorage load and server config.json load.
 */
function applyConfig(config) {
    config.routes.forEach((saved, i) => {
        if (i >= state.routes.length) return;
        const target = state.routes[i];
        if (saved.name) target.name = saved.name;
        if (saved.miles) target.miles = saved.miles;
        if (saved.riders) target.riders = saved.riders;
        if (saved.noShowRate !== undefined) target.noShowRate = saved.noShowRate;
        if (saved.speedTiers) target.speedTiers = [...saved.speedTiers];
        if (saved.startTimes) target.startTimes = JSON.parse(JSON.stringify(saved.startTimes));
        if (saved.color) target.color = saved.color;
        // Stash saved rest stops so preloadGPXFiles can overlay dwell times onto fresh GPX
        if (saved.restStops) target.restStopsFromConfig = saved.restStops;
    });

    if (config.tierWeights) state.tierWeights = [...config.tierWeights];
    if (config.speedModel) Object.assign(state.speedModel, config.speedModel);
    if (config.weather) Object.assign(state.weather, config.weather);
    if (config.defaultDwellTimes) Object.assign(state.defaultDwellTimes, config.defaultDwellTimes);

    // Refresh UI
    renderRidersTab();
    renderSettingsTab();

    document.getElementById('uphill-factor').value = state.speedModel.uphillFactor;
    document.getElementById('downhill-factor').value = state.speedModel.downhillFactor;
    document.getElementById('min-speed').value = state.speedModel.minSpeed;
    document.getElementById('max-speed').value = state.speedModel.maxSpeed;
    document.getElementById('weather-slider').value = Math.round(state.weather.factor * 100);
    document.getElementById('weather-value').textContent = `${Math.round(state.weather.factor * 100)}%`;
    document.getElementById('weather-start-hour').value = state.weather.startHour;

    const weightIds = ['weight-max', 'weight-upper', 'weight-mid', 'weight-lower', 'weight-min'];
    weightIds.forEach((id, i) => {
        document.getElementById(id).value = Math.round(state.tierWeights[i] * 100);
    });
}

// ===== TAB NAVIGATION =====
function initTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.dataset.tab;

            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
            document.getElementById(`tab-${tabId}`).classList.add('active');
        });
    });
}

// ===== HEADER ACTIONS =====
function bindHeaderActions() {
    document.getElementById('btn-run').addEventListener('click', runSimulation);
    document.getElementById('btn-save').addEventListener('click', saveConfig);
    document.getElementById('btn-load').addEventListener('click', () => {
        document.getElementById('file-load-config').click();
    });
    document.getElementById('file-load-config').addEventListener('change', loadConfig);
}

// ===== STATUS BAR =====
function updateStatusBar() {
    const loaded = state.routes.filter(r => r.gpxLoaded).length;
    document.getElementById('status-count').textContent = `${loaded} / ${state.routes.length} routes loaded`;

    if (loaded === 0) {
        document.getElementById('status-text').textContent = 'Load GPX files and configure routes to begin.';
    } else if (loaded < state.routes.length) {
        document.getElementById('status-text').textContent = `${state.routes.length - loaded} route(s) still need GPX files.`;
    } else if (state.simulationResults) {
        document.getElementById('status-text').textContent = '✅ Simulation complete. View Results and Reports tabs.';
    } else {
        document.getElementById('status-text').textContent = 'All routes loaded! Click "Run Simulation" to generate results.';
    }
}

// ===== ROUTE CARDS =====
function renderRouteCards() {
    const container = document.getElementById('route-cards');
    container.innerHTML = '';

    state.routes.forEach((route, index) => {
        const card = document.createElement('div');
        card.className = `route-card ${route.gpxLoaded ? 'loaded' : ''}`;
        card.style.borderColor = route.color;

        card.innerHTML = `
            <div class="route-card-header">
                <span class="route-name" style="color: ${route.color}">${route.name}</span>
                <span class="route-badge ${route.gpxLoaded ? 'loaded' : ''}">${route.gpxLoaded ? '✓ Loaded' : 'No GPX'}</span>
            </div>
            <div class="route-dropzone" id="dropzone-${index}">
                <span class="drop-icon">📁</span>
                Upload GPX file<br>
                <small>or click to browse</small>
                <input type="file" accept=".gpx" style="display:none" id="gpx-input-${index}">
            </div>
            ${route.gpxLoaded ? renderRouteStats(route) : ''}
            <div class="route-actions">
                ${route.gpxLoaded ? `
                    <button class="btn btn-small" onclick="window.app.showRestStopEditor(${index})">🛑 Rest Stops (${route.restStops.length})</button>
                    <button class="btn btn-small" onclick="window.app.showSegmentPreview(${index})">📋 Segments</button>
                    <button class="btn btn-small btn-danger" onclick="window.app.clearRoute(${index})">✕ Clear</button>
                ` : ''}
            </div>
        `;

        // GPX upload handlers
        const dropzone = card.querySelector(`#dropzone-${index}`);
        const fileInput = card.querySelector(`#gpx-input-${index}`);

        dropzone.addEventListener('click', () => fileInput.click());
        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('dragover');
        });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            if (e.dataTransfer.files.length) handleGPXUpload(index, e.dataTransfer.files[0]);
        });
        fileInput.addEventListener('change', () => {
            if (fileInput.files.length) handleGPXUpload(index, fileInput.files[0]);
        });

        container.appendChild(card);
    });
}

function renderRouteStats(route) {
    const s = route.parsedRoute.stats;
    return `
        <div class="route-stats">
            <div class="stat">
                <span class="stat-label">Distance</span>
                <span class="stat-value">${s.totalDistance} mi</span>
            </div>
            <div class="stat">
                <span class="stat-label">Climbing</span>
                <span class="stat-value">${s.totalClimbing.toLocaleString()} ft</span>
            </div>
            <div class="stat">
                <span class="stat-label">Segments</span>
                <span class="stat-value">${s.segmentCount}</span>
            </div>
            <div class="stat">
                <span class="stat-label">Rest Stops</span>
                <span class="stat-value">${route.restStops.length}</span>
            </div>
        </div>
    `;
}

// ===== GPX UPLOAD =====
async function handleGPXUpload(routeIndex, file) {
    try {
        const xmlText = await file.text();
        const parsed = gpxParser.parseXML(xmlText);
        const route = state.routes[routeIndex];

        route.parsedRoute = parsed;
        route.gpxLoaded = true;
        route.gpxRawXml = xmlText;

        // GPX wins: preserve any existing dwell times when re-uploading
        route.restStops = overlayDwellTimes(parsed.restStops, route.restStops || []);
        route.policePoints = parsed.policeStops || [];
        state.simulationResults = null;

        renderRouteCards();
        updateStatusBar();
    } catch (err) {
        alert(`Error parsing GPX file for ${state.routes[routeIndex].name}: ${err.message}`);
    }
}

/** Re-parse a route from stored raw XML text (used when loading config) */
function reloadRouteFromXml(routeIndex) {
    const xmlText = state.routes[routeIndex].gpxRawXml;
    if (!xmlText) return;
    try {
        const parsed = gpxParser.parseXML(xmlText);
        state.routes[routeIndex].parsedRoute = parsed;
        state.routes[routeIndex].gpxLoaded = true;
        // Restore rest stops from config if they were customized, otherwise use parsed
        if (!state.routes[routeIndex].restStops || state.routes[routeIndex].restStops.length === 0) {
            state.routes[routeIndex].restStops = parsed.restStops;
        }
    } catch (err) {
        console.warn(`Could not re-parse GPX for ${state.routes[routeIndex].name}: ${err.message}`);
        state.routes[routeIndex].gpxLoaded = false;
    }
}

// ===== REST STOP EDITOR =====
function showRestStopEditor(routeIndex) {
    const route = state.routes[routeIndex];
    const editor = document.getElementById('rest-stop-editor');
    const title = editor.querySelector('#rs-editor-title span');
    title.textContent = route.name;

    const tbody = document.getElementById('rest-stop-tbody');
    tbody.innerHTML = '';

    route.restStops.forEach((rs, rsIndex) => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td><input type="text" value="${rs.name}" onchange="window.app.updateRestStop(${routeIndex}, ${rsIndex}, 'name', this.value)" style="width:140px"></td>
            <td>${rs.mile.toFixed(1)}</td>
            <td><input type="number" value="${rs.dwellTimes.max}" min="0" max="60" step="1" onchange="window.app.updateRestStopDwell(${routeIndex}, ${rsIndex}, 'max', this.value)" style="width:50px"> min</td>
            <td><input type="number" value="${rs.dwellTimes.upper}" min="0" max="60" step="1" onchange="window.app.updateRestStopDwell(${routeIndex}, ${rsIndex}, 'upper', this.value)" style="width:50px"> min</td>
            <td><input type="number" value="${rs.dwellTimes.mid}" min="0" max="60" step="1" onchange="window.app.updateRestStopDwell(${routeIndex}, ${rsIndex}, 'mid', this.value)" style="width:50px"> min</td>
            <td><input type="number" value="${rs.dwellTimes.lower}" min="0" max="60" step="1" onchange="window.app.updateRestStopDwell(${routeIndex}, ${rsIndex}, 'lower', this.value)" style="width:50px"> min</td>
            <td><input type="number" value="${rs.dwellTimes.min}" min="0" max="60" step="1" onchange="window.app.updateRestStopDwell(${routeIndex}, ${rsIndex}, 'min', this.value)" style="width:50px"> min</td>
            <td><button class="btn btn-small btn-danger" onclick="window.app.removeRestStop(${routeIndex}, ${rsIndex})">✕</button></td>
        `;
        tbody.appendChild(row);
    });

    // Add button
    const addBtn = document.getElementById('btn-add-rest-stop');
    addBtn.onclick = () => addRestStop(routeIndex);

    editor.classList.remove('hidden');
    editor.dataset.routeIndex = routeIndex;
}

function addRestStop(routeIndex) {
    const route = state.routes[routeIndex];
    if (!route.parsedRoute) return;

    const segCount = route.parsedRoute.segments.length;
    const midSeg = Math.floor(segCount / 2);
    const seg = route.parsedRoute.segments[midSeg];

    route.restStops.push({
        name: `New Rest Stop`,
        segmentIndex: midSeg,
        mile: seg ? seg.cumulativeDistance : 0,
        lat: seg ? seg.startLat : 0,
        lon: seg ? seg.startLon : 0,
        dwellTimes: { ...state.defaultDwellTimes }
    });

    showRestStopEditor(routeIndex);
}

function removeRestStop(routeIndex, rsIndex) {
    state.routes[routeIndex].restStops.splice(rsIndex, 1);
    showRestStopEditor(routeIndex);
}

function updateRestStop(routeIndex, rsIndex, field, value) {
    state.routes[routeIndex].restStops[rsIndex][field] = value;

    // If name changed, update mile based on matching segment
    if (field === 'segmentIndex') {
        const seg = state.routes[routeIndex].parsedRoute.segments[parseInt(value)];
        if (seg) state.routes[routeIndex].restStops[rsIndex].mile = seg.cumulativeDistance;
    }
}

function updateRestStopDwell(routeIndex, rsIndex, tier, value) {
    state.routes[routeIndex].restStops[rsIndex].dwellTimes[tier] = parseInt(value) || 0;
}

// ===== SEGMENT PREVIEW =====
function showSegmentPreview(routeIndex) {
    const route = state.routes[routeIndex];
    if (!route.parsedRoute) return;

    document.getElementById('seg-preview-route').textContent = route.name;
    const tbody = document.getElementById('segment-tbody');
    tbody.innerHTML = '';

    const restStopSegIds = new Set(route.restStops.map(rs => rs.segmentIndex));

    route.parsedRoute.segments.forEach(seg => {
        const isRS = restStopSegIds.has(seg.id);
        const rsName = isRS ? route.restStops.find(rs => rs.segmentIndex === seg.id)?.name : '';
        const row = document.createElement('tr');
        if (isRS) row.classList.add('rest-stop-row');

        const gradeColor = seg.grade > 1 ? 'var(--danger)' : seg.grade < -1 ? 'var(--success)' : 'var(--text-muted)';
        const gradeWidth = Math.min(Math.abs(seg.grade) * 8, 60);

        row.innerHTML = `
            <td>${seg.id + 1}${isRS ? ` <span class="rest-stop-marker" title="${rsName}"></span>` : ''}</td>
            <td>${seg.distance.toFixed(3)}</td>
            <td>${seg.cumulativeDistance.toFixed(2)}</td>
            <td>
                <span class="badge-${seg.type}">${seg.grade > 0 ? '+' : ''}${seg.grade.toFixed(1)}%</span>
                <span class="grade-bar" style="width:${gradeWidth}px; background:${gradeColor}"></span>
            </td>
            <td><span class="badge-${seg.type}">${seg.type}</span></td>
            <td>${seg.elevationGain >= 0 ? '+' : ''}${seg.elevationGain.toFixed(1)}</td>
        `;
        tbody.appendChild(row);
    });

    document.getElementById('segment-preview').classList.remove('hidden');
}

// ===== RIDERS TAB =====
function renderRidersTab() {
    renderRiderCounts();
    renderStartTimes();
}

function renderRiderCounts() {
    const tbody = document.getElementById('rider-counts-tbody');
    tbody.innerHTML = '';

    state.routes.forEach((route, i) => {
        const row = document.createElement('tr');
        const expected = Math.round(route.riders * (1 - route.noShowRate));
        row.innerHTML = `
            <td style="color: ${route.color}; font-weight: 600">${route.name}</td>
            <td><input type="number" value="${route.riders}" min="0" max="5000" step="1"
                onchange="window.app.updateRiders(${i}, this.value)"></td>
            <td><input type="number" value="${Math.round(route.noShowRate * 100)}" min="0" max="50" step="1"
                onchange="window.app.updateNoShow(${i}, this.value)">%</td>
            <td>${expected}</td>
        `;
        tbody.appendChild(row);
    });

    updateTotals();
}

function updateRiders(routeIndex, value) {
    state.routes[routeIndex].riders = parseInt(value) || 0;
    renderRiderCounts();
}

function updateNoShow(routeIndex, value) {
    state.routes[routeIndex].noShowRate = (parseInt(value) || 0) / 100;
    renderRiderCounts();
}

function updateTotals() {
    const totalReg = state.routes.reduce((sum, r) => sum + r.riders, 0);
    const totalExp = state.routes.reduce((sum, r) => sum + Math.round(r.riders * (1 - r.noShowRate)), 0);
    document.getElementById('total-registered').textContent = totalReg.toLocaleString();
    document.getElementById('total-expected').textContent = totalExp.toLocaleString();
}

function renderStartTimes() {
    const container = document.getElementById('start-times-container');
    container.innerHTML = '';

    // Available time slots: 5:00 AM through 10:00 AM in 30-min increments
    const slots = [];
    for (let h = 5; h <= 10; h += 0.5) {
        slots.push(h);
    }

    state.routes.forEach((route, routeIdx) => {
        const div = document.createElement('div');
        div.className = 'start-time-route';

        const total = route.startTimes.reduce((s, st) => s + st.percentage, 0);
        const totalPct = Math.round(total * 100);
        const valid = totalPct === 100;

        let slotsHTML = '';
        slots.forEach(slotHour => {
            const existing = route.startTimes.find(st => st.hour === slotHour);
            const pct = existing ? Math.round(existing.percentage * 100) : 0;
            slotsHTML += `
                <div class="time-slot">
                    <label>${formatTimeShort(slotHour)}</label>
                    <input type="number" value="${pct}" min="0" max="100" step="5"
                        data-route="${routeIdx}" data-hour="${slotHour}"
                        onchange="window.app.updateStartTime(${routeIdx}, ${slotHour}, this.value)">
                </div>
            `;
        });

        div.innerHTML = `
            <h4 style="color: ${route.color}">🚴 ${route.name}</h4>
            <div class="start-time-slots">
                ${slotsHTML}
            </div>
            <div class="start-time-total ${valid ? 'valid' : 'invalid'}">
                Total: ${totalPct}% ${valid ? '✓' : '(must be 100%)'}
            </div>
        `;

        container.appendChild(div);
    });
}

function updateStartTime(routeIndex, hour, pctValue) {
    const pct = (parseInt(pctValue) || 0) / 100;
    const route = state.routes[routeIndex];

    const existing = route.startTimes.find(st => st.hour === hour);
    if (existing) {
        if (pct <= 0) {
            route.startTimes = route.startTimes.filter(st => st.hour !== hour);
        } else {
            existing.percentage = pct;
        }
    } else if (pct > 0) {
        route.startTimes.push({ hour, percentage: pct });
        route.startTimes.sort((a, b) => a.hour - b.hour);
    }

    renderStartTimes();
}

// ===== SETTINGS TAB =====
function renderSettingsTab() {
    renderSpeedTiers();
    renderDwellTimes();
    bindWeightInputs();
    bindSettingInputs();
    renderAssumptions();
}

function renderAssumptions() {
    const tbody = document.getElementById('assumptions-tbody');
    if (!tbody) return;

    const sm = state.speedModel;
    const w = state.weather;
    const weatherStartStr = w.startHour >= 13 ? `${w.startHour - 12}:00 PM` : w.startHour === 12 ? '12:00 PM' : `${w.startHour}:00 AM`;

    // Gather default dwell times from state
    const dd = state.defaultDwellTimes;
    const dwellStr = `Max: ${dd.max}, Upper: ${dd.upper}, Mid: ${dd.mid}, Lower: ${dd.lower}, Min: ${dd.min} min`;

    const assumptions = [
        ['Uphill Speed Penalty', `${sm.uphillFactor} mph per 1% grade`, 'Speed decreases for each 1% of uphill grade'],
        ['Downhill Speed Bonus', `${sm.downhillFactor} mph per 1% grade`, 'Speed increases for each 1% of downhill grade'],
        ['Minimum Speed Cap', `${sm.minSpeed} mph`, 'Riders never go slower than this on steep climbs'],
        ['Maximum Speed Cap', `${sm.maxSpeed} mph`, 'Riders never go faster than this on descents'],
        ['Rest Stop Dwell Times', dwellStr, 'Time spent at each rest stop varies by rider tier'],
        ['Weather Slowdown', `${w.factor * 100}% after ${weatherStartStr}`, 'Afternoon heat reduces rider speed progressively'],
        ['No-Show Rate', `${(state.routes[0]?.noShowRate || 0.10) * 100}%`, 'Percentage of registered riders who don\'t show up'],
        ['Time Resolution', '30-minute bands', 'Rider counts aggregated in half-hour windows'],
        ['Rider Distribution', '5 speed tiers per start window', 'Each start group split into max/upper/mid/lower/min speed tiers'],
    ];

    tbody.innerHTML = assumptions.map(([param, value, desc]) => `
        <tr>
            <td style="font-weight:600">${param}</td>
            <td>${value}</td>
            <td style="color: var(--text-secondary); font-size:0.85rem">${desc}</td>
        </tr>
    `).join('');
}

function renderSpeedTiers() {
    const tbody = document.getElementById('speed-tiers-tbody');
    tbody.innerHTML = '';

    state.routes.forEach((route, i) => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td style="color: ${route.color}; font-weight: 600">${route.name}</td>
            ${route.speedTiers.map((speed, t) => `
                <td><input type="number" value="${speed}" min="3" max="30" step="0.5"
                    onchange="window.app.updateSpeedTier(${i}, ${t}, this.value)"></td>
            `).join('')}
        `;
        tbody.appendChild(row);
    });
}

function renderDwellTimes() {
    const d = state.defaultDwellTimes;
    const ids = ['dwell-max', 'dwell-upper', 'dwell-mid', 'dwell-lower', 'dwell-min'];
    const tiers = ['max', 'upper', 'mid', 'lower', 'min'];
    ids.forEach((id, i) => {
        const el = document.getElementById(id);
        if (el) el.value = d[tiers[i]];
    });
}

function updateDefaultDwellTime(tier, value) {
    state.defaultDwellTimes[tier] = parseInt(value) || 0;
    renderAssumptions();
}

function updateSpeedTier(routeIndex, tierIndex, value) {
    console.log(`[DEBUG] updateSpeedTier START: route ${routeIndex}, tier ${tierIndex}, value ${value}`);
    console.log(`[DEBUG] Before update: ${JSON.stringify(state.routes[routeIndex].speedTiers)}`);
    state.routes[routeIndex].speedTiers[tierIndex] = parseFloat(value) || 10;
    console.log(`[DEBUG] After update: ${JSON.stringify(state.routes[routeIndex].speedTiers)}`);
    renderSpeedTiers();
}

function bindWeightInputs() {
    const ids = ['weight-max', 'weight-upper', 'weight-mid', 'weight-lower', 'weight-min'];
    ids.forEach((id, i) => {
        document.getElementById(id).addEventListener('change', () => {
            state.tierWeights[i] = (parseInt(document.getElementById(id).value) || 0) / 100;
            const total = Math.round(state.tierWeights.reduce((s, w) => s + w, 0) * 100);
            const span = document.getElementById('weight-total');
            span.textContent = `Total: ${total}%`;
            span.className = `weight-total ${total === 100 ? '' : 'error'}`;
        });
    });
}

function bindSettingInputs() {
    // Gradient model
    document.getElementById('uphill-factor').addEventListener('change', (e) => {
        state.speedModel.uphillFactor = parseFloat(e.target.value) || 1.0;
    });
    document.getElementById('downhill-factor').addEventListener('change', (e) => {
        state.speedModel.downhillFactor = parseFloat(e.target.value) || 0.5;
    });
    document.getElementById('min-speed').addEventListener('change', (e) => {
        state.speedModel.minSpeed = parseFloat(e.target.value) || 3;
    });
    document.getElementById('max-speed').addEventListener('change', (e) => {
        state.speedModel.maxSpeed = parseFloat(e.target.value) || 30;
    });

    // Weather
    const weatherSlider = document.getElementById('weather-slider');
    const weatherValue = document.getElementById('weather-value');
    weatherSlider.addEventListener('input', () => {
        state.weather.factor = parseInt(weatherSlider.value) / 100;
        weatherValue.textContent = `${weatherSlider.value}%`;
    });

    document.getElementById('weather-start-hour').addEventListener('change', (e) => {
        state.weather.startHour = parseFloat(e.target.value) || 12;
    });
}

// ===== SIMULATION =====
function runSimulation() {
    console.log(`[DEBUG] runSimulation START. Geronimo speedTiers: ${JSON.stringify(state.routes[0].speedTiers)}`);
    
    // Validate inputs
    const loadedRoutes = state.routes.filter(r => r.gpxLoaded);
    if (loadedRoutes.length === 0) {
        alert('Please load at least one GPX file before running the simulation.');
        return;
    }

    // Validate start times
    for (const route of state.routes) {
        if (!route.gpxLoaded) continue;
        const total = route.startTimes.reduce((s, st) => s + st.percentage, 0);
        if (Math.abs(total - 1.0) > 0.02) {
            alert(`Start times for ${route.name} don't add up to 100% (currently ${Math.round(total * 100)}%).`);
            return;
        }
    }

    // Validate tier weights
    const weightTotal = state.tierWeights.reduce((s, w) => s + w, 0);
    if (Math.abs(weightTotal - 1.0) > 0.02) {
        alert(`Speed tier weights don't add up to 100% (currently ${Math.round(weightTotal * 100)}%).`);
        return;
    }

    // Update speed model
    speedModel = new SpeedModel({
        ...state.speedModel,
        weatherFactor: state.weather.factor,
        weatherStartHour: state.weather.startHour,
    });
    const sim = new Simulation(speedModel);

    // Run simulation for each loaded route
    const allResults = [];
    const allRestStopSummaries = [];

    for (const route of state.routes) {
        if (!route.gpxLoaded) continue;

        const routeConfig = {
            name: route.name,
            totalRiders: route.riders,
            noShowRate: route.noShowRate,
            speedTiers: route.speedTiers,
            tierWeights: state.tierWeights,
            startTimes: route.startTimes,
        };

        const simResult = sim.runRouteSimulation(
            routeConfig,
            route.parsedRoute.segments,
            route.restStops
        );

        // Create heatmap
        const heatmap = aggregation.createHeatmap(simResult, route.parsedRoute.segments);

        // Rest stop summary
        const restStopSummary = aggregation.createRestStopSummary(simResult, route.restStops);

        allResults.push({
            routeName: route.name,
            routeColor: route.color,
            simResult,
            heatmap,
            restStopSummary,
            finishRange: sim.getFinishTimeRange(simResult),
        });

        allRestStopSummaries.push({
            routeName: route.name,
            summaries: restStopSummary,
        });
    }

    // Aggregate rest stops across routes
    const aggregatedRestStops = aggregation.aggregateRestStops(allRestStopSummaries);

    // Finish line summary (aggregated across all routes using last segment arrival)
    const finishLineData = allResults.map(r => ({
        routeName: r.routeName,
        simResult: r.simResult
    }));
    const finishLineSummary = aggregation.createFinishLineSummary(finishLineData);

    // Police point summaries
    const allPoliceSummaries = [];
    for (const route of state.routes) {
        if (!route.gpxLoaded || !route.policePoints?.length) continue;
        const routeResult = allResults.find(r => r.routeName === route.name);
        if (!routeResult) continue;
        const policeSummary = aggregation.createPoliceSummary(routeResult.simResult, route.policePoints);
        allPoliceSummaries.push({ routeName: route.name, summaries: policeSummary });
    }
    const aggregatedPolice = aggregation.aggregatePolicePoints(allPoliceSummaries);

    state.simulationResults = allResults;
    state.aggregatedResults = aggregatedRestStops;
    state.finishLineSummary = finishLineSummary;
    state.aggregatedPolice = aggregatedPolice;

    renderResults();
    renderPolice();
    renderReports();
    updateStatusBar();

    // Switch to results tab
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-tab="results"]').classList.add('active');
    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
    document.getElementById('tab-results').classList.add('active');
}

// ===== RENDER RESULTS =====
function renderResults() {
    document.getElementById('results-empty').classList.add('hidden');
    document.getElementById('results-content').classList.remove('hidden');

    renderRestStopSchedule();
    renderHeatmapSelector();
    renderFinishSummary();
}

function renderRestStopSchedule() {
    const timeBands = aggregation.getTimeBands();
    const thead = document.getElementById('rs-schedule-head');
    const tbody = document.getElementById('rs-schedule-body');

    // Header
    thead.innerHTML = `<tr>
        <th>Rest Stop</th>
        <th>Routes</th>
        <th>Setup</th>
        <th>Open</th>
        <th>Peak</th>
        <th>Close</th>
        <th>Total</th>
        ${timeBands.map(b => `<th class="heat-cell angled-header"><span>${b.label}</span></th>`).join('')}
    </tr>`;

    // Body
    tbody.innerHTML = '';
    if (!state.aggregatedResults) return;

    // Include finish line in max count calculation for heat coloring
    const allBandCounts = state.finishLineSummary
        ? [...state.aggregatedResults.flatMap(r => r.bandCounts), ...state.finishLineSummary.bandCounts]
        : state.aggregatedResults.flatMap(r => r.bandCounts);
    const maxCount = Math.max(...allBandCounts);

    state.aggregatedResults.forEach(rs => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td><strong>${rs.name}</strong></td>
            <td style="font-size:0.75rem; color:var(--text-muted)">${rs.routes.join(', ')}</td>
            <td>${aggregation.formatTimeShort(rs.setupTime)}</td>
            <td>${aggregation.formatTimeShort(rs.openTime)}</td>
            <td>${rs.peakBand} <span style="color:var(--warning)">(${rs.peakCount})</span></td>
            <td>${aggregation.formatTimeShort(rs.closeTime)}</td>
            <td class="riders-col">${rs.totalRiders}</td>
            ${rs.bandCounts.map(c => {
            const level = getHeatLevel(c, maxCount);
            return `<td class="heat-cell heat-${level}">${c || ''}</td>`;
        }).join('')}
        `;
        tbody.appendChild(row);
    });

    // Append Finish Line row at the bottom
    if (state.finishLineSummary) {
        const fl = state.finishLineSummary;
        const finishRow = document.createElement('tr');
        finishRow.style.borderTop = '2px solid var(--border)';
        finishRow.innerHTML = `
            <td><strong>🏁 ${fl.name}</strong></td>
            <td style="font-size:0.75rem; color:var(--text-muted)">${fl.routes.join(', ')}</td>
            <td>${aggregation.formatTimeShort(fl.setupTime)}</td>
            <td>${aggregation.formatTimeShort(fl.openTime)}</td>
            <td>${fl.peakBand} <span style="color:var(--warning)">(${fl.peakCount})</span></td>
            <td>${aggregation.formatTimeShort(fl.closeTime)}</td>
            <td class="riders-col"><strong>${fl.totalRiders}</strong></td>
            ${fl.bandCounts.map(c => {
            const level = getHeatLevel(c, maxCount);
            return `<td class="heat-cell heat-${level}">${c || ''}</td>`;
        }).join('')}
        `;
        tbody.appendChild(finishRow);
    }
}

function getHeatLevel(count, maxCount) {
    if (count === 0) return 0;
    const ratio = count / maxCount;
    if (ratio <= 0.1) return 1;
    if (ratio <= 0.25) return 2;
    if (ratio <= 0.45) return 3;
    if (ratio <= 0.65) return 4;
    if (ratio <= 0.85) return 5;
    return 6;
}

function renderHeatmapSelector() {
    const select = document.getElementById('heatmap-route-select');
    select.innerHTML = '<option value="">Select Route</option>';

    state.simulationResults.forEach((result, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = result.routeName;
        select.appendChild(opt);
    });

    select.onchange = () => {
        const idx = parseInt(select.value);
        if (!isNaN(idx)) {
            renderHeatmap(idx);
            updateHeatmapRiderCount(idx);
        }
    };

    // Auto-select first
    if (state.simulationResults.length > 0) {
        select.value = '0';
        renderHeatmap(0);
        updateHeatmapRiderCount(0);
    }
}

function updateHeatmapRiderCount(resultIndex) {
    const result = state.simulationResults[resultIndex];
    const countEl = document.getElementById('heatmap-rider-count');
    if (result && countEl) {
        countEl.textContent = `Riders: ${result.simResult.effectiveRiders}`;
    }
}

function renderHeatmap(resultIndex) {
    const result = state.simulationResults[resultIndex];
    if (!result) return;

    const { timeBands, heatmap } = result.heatmap;
    const route = state.routes.find(r => r.name === result.routeName);
    const restStopSegIds = new Set((route?.restStops || []).map(rs => rs.segmentIndex));
    const waypointsBySegment = route?.parsedRoute?.waypointsBySegment || {};

    const thead = document.getElementById('heatmap-head');
    const tbody = document.getElementById('heatmap-body');

    thead.innerHTML = `<tr>
        <th>Seg</th>
        <th>Mile</th>
        <th>Dist</th>
        <th>Grade</th>
        ${timeBands.map(b => `<th class="heat-cell angled-header"><span>${b.label}</span></th>`).join('')}
    </tr>`;

    tbody.innerHTML = '';
    const maxCount = Math.max(...heatmap.flatMap(r => r.counts));

    heatmap.forEach(row => {
        const isRS = restStopSegIds.has(row.segmentId);
        const rsName = isRS ? (route.restStops.find(rs => rs.segmentIndex === row.segmentId)?.name || '') : '';
        const nearbyWaypoints = waypointsBySegment[row.segmentId] || [];

        const tr = document.createElement('tr');
        if (isRS) tr.classList.add('rest-stop-row');

        // Build tooltip text
        let tooltipText = `Segment ${row.segmentId + 1}`;
        if (isRS) tooltipText = `🛑 ${rsName}`;
        if (nearbyWaypoints.length > 0) {
            tooltipText += `\n📍 ${nearbyWaypoints.join('\n📍 ')}`;
        }
        tooltipText += `\nMile ${row.mile.toFixed(1)} | ${row.distance.toFixed(2)} mi | ${row.grade > 0 ? '+' : ''}${row.grade.toFixed(1)}% grade`;

        // Build segment cell programmatically to preserve title attribute
        const segTd = document.createElement('td');
        segTd.setAttribute('title', tooltipText);
        segTd.style.cursor = 'help';
        if (isRS) {
            segTd.innerHTML = `${row.segmentId + 1} <span class="rest-stop-marker"></span><br><span class="rest-stop-label">${rsName}</span>`;
        } else {
            segTd.textContent = `${row.segmentId + 1}${nearbyWaypoints.length > 0 ? ' 📍' : ''}`;
        }

        // Build remaining cells as HTML
        const dataCells = `
            <td>${row.mile.toFixed(1)}</td>
            <td>${row.distance.toFixed(2)}</td>
            <td><span class="badge-${row.type}">${row.grade > 0 ? '+' : ''}${row.grade.toFixed(1)}%</span></td>
            ${row.counts.map(c => {
            const level = getHeatLevel(c, maxCount);
            return `<td class="heat-cell heat-${level}">${c || ''}</td>`;
        }).join('')}
        `;

        tr.appendChild(segTd);
        // Create a temporary container for the data cells
        const temp = document.createElement('tr');
        temp.innerHTML = dataCells;
        while (temp.firstChild) {
            tr.appendChild(temp.firstChild);
        }
        tbody.appendChild(tr);
    });
}

function renderFinishSummary() {
    const tbody = document.getElementById('finish-tbody');
    tbody.innerHTML = '';

    state.simulationResults.forEach(result => {
        const { earliest, latest } = result.finishRange;
        const spreadHours = latest - earliest;
        const spreadStr = `${Math.floor(spreadHours)}h ${Math.round((spreadHours % 1) * 60)}m`;

        // Find route to get distance
        const route = state.routes.find(r => r.name === result.routeName);
        const totalDistance = route?.parsedRoute?.stats?.totalDistance || 0;

        // Calculate weighted average finish time and collect finish data
        let totalWeightedFinish = 0;
        let totalRiderWeight = 0;
        let earliestStart = Infinity;
        let latestStart = 0;
        let avgStart = 0;

        const finishData = [];
        for (const { slug, results } of result.simResult.slugResults) {
            const finish = results[results.length - 1];
            if (finish) {
                const finishTime = finish.departureTime;
                const riderCount = slug.riderCount;
                totalWeightedFinish += finishTime * riderCount;
                totalRiderWeight += riderCount;
                avgStart += slug.startHour * riderCount;
                finishData.push({ finishTime, startHour: slug.startHour, riderCount });

                // Track which slug finishes earliest/latest
                if (finishTime <= earliest + 0.001) earliestStart = slug.startHour;
                if (finishTime >= latest - 0.001) latestStart = slug.startHour;
            }
        }

        const avgFinish = totalRiderWeight > 0 ? totalWeightedFinish / totalRiderWeight : 0;
        const avgStartTime = totalRiderWeight > 0 ? avgStart / totalRiderWeight : 0;

        // Calculate speeds (mph) = distance / ride_time_hours
        const firstRideTime = earliest - earliestStart;
        const avgRideTime = avgFinish - avgStartTime;
        const lastRideTime = latest - latestStart;

        const firstSpeed = firstRideTime > 0 ? (totalDistance / firstRideTime).toFixed(1) : '—';
        const avgSpeed = avgRideTime > 0 ? (totalDistance / avgRideTime).toFixed(1) : '—';
        const lastSpeed = lastRideTime > 0 ? (totalDistance / lastRideTime).toFixed(1) : '—';

        const row = document.createElement('tr');
        row.innerHTML = `
            <td style="color: ${result.routeColor}; font-weight:600">${result.routeName}</td>
            <td>${result.simResult.effectiveRiders}</td>
            <td>${totalDistance} mi</td>
            <td>${aggregation.formatTime(earliest)}</td>
            <td>${firstSpeed} mph</td>
            <td>${aggregation.formatTime(avgFinish)}</td>
            <td>${avgSpeed} mph</td>
            <td>${aggregation.formatTime(latest)}</td>
            <td>${lastSpeed} mph</td>
            <td>${spreadStr}</td>
        `;
        tbody.appendChild(row);
    });
}

// ===== REPORTS =====
function renderReports() {
    document.getElementById('reports-empty').classList.add('hidden');
    document.getElementById('reports-content').classList.remove('hidden');

    const container = document.getElementById('captain-reports');
    container.innerHTML = '';

    if (!state.aggregatedResults) return;

    state.aggregatedResults.forEach(rs => {
        const report = aggregation.generateCaptainReport(rs);
        container.appendChild(createCaptainReportCard(report));
    });

    document.getElementById('btn-print-all').onclick = () => window.print();
    document.getElementById('btn-print-summary').onclick = () => window.print();
}

function createCaptainReportCard(report) {
    const card = document.createElement('div');
    card.className = 'captain-report';
    const numSlots = report.hourlyBreakdown.length;
    if (numSlots > 10) card.classList.add('many-slots');

    const maxRiders = Math.max(...report.hourlyBreakdown.map(h => h.riders), 1);

    // Build bars with heatmap coloring
    const barsHTML = report.hourlyBreakdown.map(h => {
        const heightPct = (h.riders / maxRiders) * 100;
        const heatLevel = getHeatLevel(h.riders, maxRiders);
        const countClass = h.riders === 0 ? 'chart-count count-zero' : 'chart-count';
        // Non-zero bars get minimum 8% height so they're always visible as bars
        const displayHeight = h.riders === 0 ? 1 : Math.max(heightPct, 8);
        return `
            <div class="chart-bar-container">
                <span class="${countClass}">${h.riders}</span>
                <div class="chart-bar bar-heat-${heatLevel}" style="height: ${displayHeight}%"></div>
            </div>
        `;
    }).join('');

    // Build horizontal time labels
    const timeLabelsHTML = report.hourlyBreakdown.map(h => {
        // Split time like "8:30 AM" into parts
        const parts = h.time.match(/(\d+:\d+)\s*(AM|PM)/i);
        if (parts) {
            return `<div class="chart-time-cell"><span class="time-hour">${parts[1]}</span><span class="time-ampm">${parts[2]}</span></div>`;
        }
        return `<div class="chart-time-cell">${h.time}</div>`;
    }).join('');

    card.innerHTML = `
        <h3>🛑 ${report.name}</h3>
        <div class="report-meta">
            <div class="meta-item">Routes: <span class="meta-value">${report.routes}</span></div>
            <div class="meta-item">Total Riders: <span class="meta-value">${report.totalRiders}</span></div>
        </div>
        <div class="report-meta">
            <div class="meta-item">Setup: <span class="meta-value">${report.setup}</span></div>
            <div class="meta-item">Open: <span class="meta-value">${report.open}</span></div>
            <div class="meta-item">Peak: <span class="meta-value">${report.peakTime} (${report.peakRiders} riders)</span></div>
            <div class="meta-item">Close: <span class="meta-value">${report.close}</span></div>
        </div>
        <div class="hourly-chart">${barsHTML}</div>
        <div class="chart-time-row">${timeLabelsHTML}</div>
    `;

    return card;
}

// ===== POLICE TAB =====
function renderPolice() {
    const emptyEl = document.getElementById('police-empty');
    const contentEl = document.getElementById('police-content');
    if (!emptyEl || !contentEl) return;

    if (!state.aggregatedPolice || state.aggregatedPolice.length === 0) {
        emptyEl.classList.remove('hidden');
        contentEl.classList.add('hidden');
        return;
    }

    emptyEl.classList.add('hidden');
    contentEl.classList.remove('hidden');

    const timeBands = aggregation.getTimeBands();
    const thead = document.getElementById('police-schedule-head');
    const tbody = document.getElementById('police-schedule-body');

    thead.innerHTML = `<tr>
        <th>CHP / Police Position</th>
        <th>Routes</th>
        <th>Arrive By</th>
        <th>First Rider</th>
        <th>Peak</th>
        <th>Last Rider</th>
        <th>Total</th>
        ${timeBands.map(b => `<th class="heat-cell angled-header"><span>${b.label}</span></th>`).join('')}
    </tr>`;

    tbody.innerHTML = '';
    const maxCount = Math.max(...state.aggregatedPolice.flatMap(p => p.bandCounts), 1);

    state.aggregatedPolice.forEach(pt => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td><strong>${pt.name}</strong></td>
            <td style="font-size:0.75rem; color:var(--text-muted)">${pt.routes.join(', ')}</td>
            <td>${aggregation.formatTimeShort(pt.setupTime)}</td>
            <td>${aggregation.formatTimeShort(pt.openTime)}</td>
            <td>${pt.peakBand} <span style="color:var(--warning)">(${pt.peakCount})</span></td>
            <td>${aggregation.formatTimeShort(pt.closeTime)}</td>
            <td class="riders-col">${pt.totalRiders}</td>
            ${pt.bandCounts.map(c => {
            const level = getHeatLevel(c, maxCount);
            return `<td class="heat-cell heat-${level}">${c || ''}</td>`;
        }).join('')}
        `;
        tbody.appendChild(row);
    });
}

// ===== SAVE / LOAD =====
function saveConfig() {
    // 1. Save to browser localStorage immediately — no file needed
    saveToLocalStorage();
    showToast('✅ Settings saved to browser');

    // 2. Also download the config file (for committing to GitHub / backup)
    const config = buildConfigObject();
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = 'marin-century-config.json';
    document.body.appendChild(a);
    const e = document.createEvent('MouseEvents');
    e.initEvent('click', true, true);
    a.dispatchEvent(e);
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
}

function showToast(msg) {
    let toast = document.getElementById('save-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'save-toast';
        toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:var(--success,#10b981);color:#fff;padding:10px 18px;border-radius:8px;font-weight:600;font-size:0.9rem;z-index:9999;opacity:0;transition:opacity 0.3s';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}

function clearBrowserSavedSettings() {
    if (!confirm('Clear browser-saved settings and reload from server defaults?')) return;
    localStorage.removeItem(LS_KEY);
    window.location.reload();
}

async function loadConfig(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async () => {
        try {
            const config = JSON.parse(reader.result);
            if (config.version < 1 || config.version > 3) {
                alert('Unsupported config file version.');
                return;
            }
            applyConfig(config);
            await preloadGPXFiles();
            // Save uploaded config to localStorage so it persists
            saveToLocalStorage();
            showToast('✅ Config loaded and saved to browser');
        } catch (err) {
            alert('Error loading config: ' + err.message);
        }
    };
    reader.readAsText(file);
}

// ===== HELPERS =====
function formatTimeShort(hours) {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    const p = h >= 12 ? 'p' : 'a';
    const displayH = h > 12 ? h - 12 : (h === 0 ? 12 : h);
    return `${displayH}:${m.toString().padStart(2, '0')}${p}`;
}

// ===== EXPOSE TO HTML =====
window.app = {
    showRestStopEditor,
    showSegmentPreview,
    clearRoute: (i) => {
        state.routes[i].gpxLoaded = false;
        state.routes[i].parsedRoute = null;
        state.routes[i].gpxRawXml = null;
        state.routes[i].restStops = [];
        state.simulationResults = null;
        renderRouteCards();
        updateStatusBar();
        document.getElementById('rest-stop-editor').classList.add('hidden');
        document.getElementById('segment-preview').classList.add('hidden');
    },
    updateRestStop,
    updateRestStopDwell,
    removeRestStop,
    updateRiders,
    updateNoShow,
    updateStartTime,
    updateSpeedTier,
    updateDefaultDwellTime,
    clearBrowserSavedSettings,
};

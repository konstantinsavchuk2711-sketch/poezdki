'use strict';

/* ============================================================
   База данных (IndexedDB) — хранится локально на телефоне
   ============================================================ */
const DB = (() => {
  const NAME = 'trips-db';
  const STORE = 'trips';
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode) {
    return open().then((db) => db.transaction(STORE, mode).objectStore(STORE));
  }

  return {
    add(trip) {
      return tx('readwrite').then((store) => new Promise((resolve, reject) => {
        const req = store.add(trip);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }));
    },
    all() {
      return tx('readonly').then((store) => new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }));
    },
    remove(id) {
      return tx('readwrite').then((store) => new Promise((resolve, reject) => {
        const req = store.delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      }));
    },
  };
})();

/* ============================================================
   Элементы интерфейса
   ============================================================ */
const els = {
  status: document.getElementById('status'),
  coords: document.getElementById('coords'),
  tripBtn: document.getElementById('tripBtn'),
  historyBtn: document.getElementById('historyBtn'),
  cancelBtn: document.getElementById('cancelBtn'),
  historyScreen: document.getElementById('historyScreen'),
  historyList: document.getElementById('historyList'),
  closeHistory: document.getElementById('closeHistory'),
  // Диалог
  tripDialog: document.getElementById('tripDialog'),
  orderNumber: document.getElementById('orderNumber'),
  orderError: document.getElementById('orderError'),
  comment: document.getElementById('comment'),
  dialogStart: document.getElementById('dialogStart'),
  dialogCancel: document.getElementById('dialogCancel'),
};

/* ============================================================
   Состояние
   ============================================================ */
let map, meMarker, accuracyCircle;
let startMarker = null, stopMarker = null;
let lastPosition = null;        // последняя известная точка {lat, lng, accuracy}
let tripMeta = null;            // {orderNumber, comment, startTime} текущей поездки
let state = 'idle';             // 'idle' | 'active' | 'review'
let hasCentered = false;

/* ============================================================
   Карта
   ============================================================ */
function initMap() {
  map = L.map('map', { zoomControl: true }).setView([55.751244, 37.618423], 13); // Москва по умолчанию
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
  }).addTo(map);
}

function pointIcon(kind) {
  return L.divIcon({
    className: '',
    html: `<div class="point-marker ${kind}"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

// Перетаскиваемый маркер точки (старт/финиш)
function addDraggableMarker(latlng, kind, label) {
  const marker = L.marker(latlng, {
    icon: pointIcon(kind),
    draggable: true,
    autoPan: true,
  }).addTo(map);
  marker.bindTooltip(label + ' (можно перетащить)', { direction: 'top', offset: [0, -10] });
  return marker;
}

/* ============================================================
   Геолокация
   ============================================================ */
function startGeolocation() {
  // В нативном приложении (Capacitor) сначала запрашиваем разрешение через плагин,
  // затем используем стандартный navigator.geolocation внутри WebView.
  const cap = window.Capacitor;
  const native = cap && cap.isNativePlatform && cap.isNativePlatform();
  const Geo = cap && cap.Plugins && cap.Plugins.Geolocation;
  if (native && Geo && Geo.requestPermissions) {
    Geo.requestPermissions().then(startWebGeolocation, startWebGeolocation);
  } else {
    startWebGeolocation();
  }
}

function startWebGeolocation() {
  if (!('geolocation' in navigator)) {
    setStatus('Геолокация не поддерживается этим браузером', 'error');
    return;
  }
  navigator.geolocation.watchPosition(onPosition, onGeoError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 15000,
  });
}

function onPosition(pos) {
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  lastPosition = { lat, lng, accuracy };

  // Маркер "я" + круг точности
  if (!meMarker) {
    meMarker = L.circleMarker([lat, lng], {
      radius: 8, color: '#fff', weight: 3,
      fillColor: '#1c6dd0', fillOpacity: 1,
    }).addTo(map);
    accuracyCircle = L.circle([lat, lng], {
      radius: accuracy, color: '#1c6dd0', weight: 1,
      fillColor: '#1c6dd0', fillOpacity: 0.1,
    }).addTo(map);
  } else {
    meMarker.setLatLng([lat, lng]);
    accuracyCircle.setLatLng([lat, lng]).setRadius(accuracy);
  }

  if (!hasCentered) {
    map.setView([lat, lng], 16);
    hasCentered = true;
  }

  els.coords.textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}  (±${Math.round(accuracy)} м)`;
  els.tripBtn.disabled = false;

  if (state === 'idle') setStatus('Готов к поездке', '');
}

function onGeoError(err) {
  const messages = {
    1: 'Доступ к геолокации запрещён. Разрешите его в настройках.',
    2: 'Не удалось определить местоположение.',
    3: 'Таймаут определения местоположения.',
  };
  setStatus(messages[err.code] || err.message, 'error');
}

function setStatus(text, cls) {
  els.status.textContent = text;
  els.status.className = 'status' + (cls ? ' ' + cls : '');
}

/* ============================================================
   Диалог перед поездкой
   ============================================================ */
function openDialog() {
  els.orderNumber.value = '';
  els.comment.value = '';
  els.orderError.classList.add('hidden');
  els.tripDialog.classList.remove('hidden');
  setTimeout(() => els.orderNumber.focus(), 50);
}

function closeDialog() {
  els.tripDialog.classList.add('hidden');
}

function confirmDialog() {
  const order = els.orderNumber.value.trim();
  if (order === '') {
    els.orderError.classList.remove('hidden');
    els.orderNumber.focus();
    return;
  }
  const meta = { orderNumber: order, comment: els.comment.value.trim() };
  closeDialog();
  beginTrip(meta);
}

/* ============================================================
   Поток поездки: idle → active → review → (сохранение) → idle
   ============================================================ */
function onTripButton() {
  if (!lastPosition) return;
  if (state === 'idle') openDialog();
  else if (state === 'active') enterReview();
  else if (state === 'review') saveTrip();
}

function beginTrip(meta) {
  tripMeta = { ...meta, startTime: Date.now() };
  clearTripMarkers();

  startMarker = addDraggableMarker([lastPosition.lat, lastPosition.lng], 'start', 'Старт');

  state = 'active';
  els.tripBtn.textContent = 'Закончить поездку';
  els.tripBtn.className = 'trip-btn stop';
  els.cancelBtn.classList.remove('hidden');
  setStatus('Поездка началась · наряд ' + tripMeta.orderNumber, 'active');
}

function enterReview() {
  stopMarker = addDraggableMarker([lastPosition.lat, lastPosition.lng], 'stop', 'Финиш');

  state = 'review';
  els.tripBtn.textContent = 'Сохранить поездку';
  els.tripBtn.className = 'trip-btn save';
  setStatus('Скорректируйте точки на карте и сохраните', 'active');
}

async function saveTrip() {
  const s = startMarker.getLatLng();
  const e = stopMarker.getLatLng();
  const trip = {
    orderNumber: tripMeta.orderNumber,
    comment: tripMeta.comment,
    startLat: s.lat,
    startLng: s.lng,
    startTime: tripMeta.startTime,
    endLat: e.lat,
    endLng: e.lng,
    endTime: Date.now(),
  };

  try {
    await DB.add(trip);
  } catch (err) {
    setStatus('Ошибка сохранения в базу: ' + err.message, 'error');
    return;
  }

  resetTrip();
  setStatus('Поездка сохранена ✓', 'active');
  setTimeout(() => { if (state === 'idle') setStatus('Готов к поездке', ''); }, 2500);
}

function cancelTrip() {
  resetTrip();
  setStatus('Поездка отменена', '');
  setTimeout(() => { if (state === 'idle') setStatus('Готов к поездке', ''); }, 1500);
}

function resetTrip() {
  clearTripMarkers();
  tripMeta = null;
  state = 'idle';
  els.tripBtn.textContent = 'Начать поездку';
  els.tripBtn.className = 'trip-btn start';
  els.cancelBtn.classList.add('hidden');
}

function clearTripMarkers() {
  if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
  if (stopMarker)  { map.removeLayer(stopMarker);  stopMarker = null; }
}

/* ============================================================
   История
   ============================================================ */
async function openHistory() {
  const trips = await DB.all();
  trips.sort((a, b) => b.startTime - a.startTime);
  renderHistory(trips);
  els.historyScreen.classList.remove('hidden');
}

function renderHistory(trips) {
  if (!trips.length) {
    els.historyList.innerHTML = '<div class="empty">Поездок пока нет</div>';
    return;
  }
  els.historyList.innerHTML = trips.map((t) => {
    const durMin = Math.round((t.endTime - t.startTime) / 60000);
    const comment = t.comment
      ? `<div class="trip-comment">${escapeHtml(t.comment)}</div>` : '';
    return `
      <div class="trip-card">
        <div class="trip-top">
          <span class="trip-order">Наряд № ${escapeHtml(t.orderNumber ?? '—')}</span>
          <span class="trip-date">${formatDate(t.startTime)}</span>
        </div>
        ${comment}
        <div class="point"><span class="dot start"></span>Старт: ${t.startLat.toFixed(6)}, ${t.startLng.toFixed(6)}</div>
        <div class="point"><span class="dot stop"></span>Финиш: ${t.endLat.toFixed(6)}, ${t.endLng.toFixed(6)}</div>
        <div class="meta">Длительность: ${durMin} мин · по прямой ~${distanceKm(t)} км</div>
        <button class="trip-del" data-id="${t.id}">Удалить</button>
      </div>`;
  }).join('');

  els.historyList.querySelectorAll('.trip-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await DB.remove(Number(btn.dataset.id));
      openHistory();
    });
  });
}

function distanceKm(t) {
  const R = 6371;
  const dLat = (t.endLat - t.startLat) * Math.PI / 180;
  const dLng = (t.endLng - t.startLng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(t.startLat * Math.PI / 180) * Math.cos(t.endLat * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return (R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(2);
}

function formatDate(ts) {
  return new Date(ts).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ============================================================
   Инициализация
   ============================================================ */
els.tripBtn.addEventListener('click', onTripButton);
els.cancelBtn.addEventListener('click', cancelTrip);
els.historyBtn.addEventListener('click', openHistory);
els.closeHistory.addEventListener('click', () => els.historyScreen.classList.add('hidden'));
els.dialogStart.addEventListener('click', confirmDialog);
els.dialogCancel.addEventListener('click', closeDialog);

initMap();
startGeolocation();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

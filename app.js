const STORAGE_KEY = "coffee_passport_v1";
const KEY_STORAGE = "coffee_passport_gmaps_key";

function $(id) {
  return document.getElementById(id);
}

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  const state = safeJsonParse(raw, { visitsByPlaceId: {} });
  if (!state || typeof state !== "object") return { visitsByPlaceId: {} };
  if (!state.visitsByPlaceId || typeof state.visitsByPlaceId !== "object") state.visitsByPlaceId = {};
  return state;
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function getApiKey() {
  return (localStorage.getItem(KEY_STORAGE) || "").trim();
}

function setApiKey(key) {
  localStorage.setItem(KEY_STORAGE, (key || "").trim());
}

function fileToDataUrl(file, { maxBytes } = {}) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    if (maxBytes && file.size > maxBytes) {
      return reject(new Error("Photo is too large."));
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

function formatMiles(meters) {
  if (typeof meters !== "number" || !Number.isFinite(meters)) return "";
  const miles = meters / 1609.344;
  if (miles < 0.1) return `${Math.round(miles * 5280)} ft`;
  return `${miles.toFixed(1)} mi`;
}

function setLocationStatus(text) {
  $("locationStatus").textContent = text;
}

function ensureGmapsLoaded(apiKey) {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.maps) return resolve();
    const existing = document.querySelector("script[data-gmaps]");
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Failed to load Google Maps.")));
      return;
    }

    const script = document.createElement("script");
    script.dataset.gmaps = "1";
    script.async = true;
    script.defer = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google Maps."));
    document.head.appendChild(script);
  });
}

let map;
let userMarker;
let infoWindow;
let currentPosition;
let nearbyPlaces = [];
let pendingVisit = null;
let placeMarkers = [];
let pendingShop = null;

function openSettings() {
  $("apiKey").value = getApiKey();
  $("settingsDialog").showModal();
}

function openPassport() {
  $("passportPanel").hidden = false;
  renderPassport();
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}

function togglePassport() {
  const panel = $("passportPanel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    renderPassport();
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function placePhotoMediaUrl(photoName, { maxWidthPx = 800, maxHeightPx = 800 } = {}) {
  const apiKey = getApiKey();
  if (!photoName || !apiKey) return null;
  const url = new URL(`https://places.googleapis.com/v1/${photoName}/media`);
  url.searchParams.set("maxWidthPx", String(maxWidthPx));
  url.searchParams.set("maxHeightPx", String(maxHeightPx));
  url.searchParams.set("key", apiKey);
  return url.toString();
}

async function fetchPlaceDetails(placeId) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Add your Google Maps API key in Settings.");
  if (!placeId) throw new Error("Missing place id.");

  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    method: "GET",
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "id,displayName,formattedAddress,location,photos",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Place details request failed (${res.status}).`);
  }

  return res.json();
}

function renderShopGallery({ savedPhotoDataUrl, placePhotos }) {
  const el = $("shopGallery");
  el.innerHTML = "";

  const urls = [];
  if (savedPhotoDataUrl) urls.push(savedPhotoDataUrl);

  if (Array.isArray(placePhotos)) {
    for (const p of placePhotos) {
      if (!p || !p.name) continue;
      const u = placePhotoMediaUrl(p.name, { maxWidthPx: 900, maxHeightPx: 900 });
      if (u) urls.push(u);
      if (urls.length >= 6) break;
    }
  }

  if (!urls.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No photos yet.";
    el.appendChild(empty);
    return;
  }

  for (const src of urls) {
    const item = document.createElement("div");
    item.className = "gallery__item";
    const img = document.createElement("img");
    img.alt = "Photo";
    img.loading = "lazy";
    img.src = src;
    item.appendChild(img);
    el.appendChild(item);
  }
}

async function openShopDialog(place) {
  pendingShop = place;

  const state = loadState();
  const visit = place && place.place_id ? state.visitsByPlaceId[place.place_id] : null;

  $("shopTitle").textContent = (place && place.name) || "Coffee shop";
  $("shopAddress").textContent = (place && place.vicinity) || "";
  $("btnShopVisit").textContent = visit ? "Update visit" : "Visit";

  renderShopGallery({ savedPhotoDataUrl: visit ? visit.photoDataUrl : null, placePhotos: [] });
  $("shopDialog").showModal();

  if (!place || !place.place_id) return;

  const gallery = $("shopGallery");
  const loading = document.createElement("div");
  loading.className = "muted";
  loading.textContent = "Loading photos…";
  gallery.appendChild(loading);

  try {
    const details = await fetchPlaceDetails(place.place_id);
    const latestState = loadState();
    const latestVisit = latestState.visitsByPlaceId[place.place_id] || null;

    if (details && details.displayName && details.displayName.text) {
      $("shopTitle").textContent = details.displayName.text;
    }
    if (details && details.formattedAddress) {
      $("shopAddress").textContent = details.formattedAddress;
    }

    renderShopGallery({
      savedPhotoDataUrl: latestVisit ? latestVisit.photoDataUrl : null,
      placePhotos: Array.isArray(details && details.photos) ? details.photos : [],
    });
  } catch (e) {
    const err = document.createElement("div");
    err.className = "muted";
    err.textContent = e instanceof Error ? e.message : "Could not load photos.";
    gallery.appendChild(err);
  }
}

function renderShops() {
  const state = loadState();
  const container = $("shops");
  container.innerHTML = "";

  if (!nearbyPlaces.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No results yet.";
    container.appendChild(empty);
    return;
  }

  for (const p of nearbyPlaces) {
    const visit = state.visitsByPlaceId[p.place_id];

    const el = document.createElement("div");
    el.className = "shop";

    const top = document.createElement("div");
    top.className = "shop__top";

    const left = document.createElement("div");

    const name = document.createElement("div");
    name.className = "shop__name";
    name.textContent = p.name || "Coffee shop";

    const meta = document.createElement("div");
    meta.className = "shop__meta";

    const addr = document.createElement("div");
    addr.textContent = p.vicinity || "";

    const row2 = document.createElement("div");
    row2.textContent = [
      typeof p.rating === "number" ? `Google: ${p.rating.toFixed(1)}★` : null,
      typeof p.user_ratings_total === "number" ? `${p.user_ratings_total} reviews` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    meta.appendChild(addr);
    if (row2.textContent) meta.appendChild(row2);

    left.appendChild(name);
    left.appendChild(meta);

    const right = document.createElement("div");
    right.style.display = "grid";
    right.style.gap = "8px";
    right.style.justifyItems = "end";

    const badges = document.createElement("div");
    badges.style.display = "flex";
    badges.style.gap = "8px";
    badges.style.flexWrap = "wrap";
    badges.style.justifyContent = "flex-end";

    if (p._distanceMeters != null) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = formatMiles(p._distanceMeters);
      badges.appendChild(b);
    }

    if (visit) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = `Visited: ${visit.rating || "–"}★`;
      badges.appendChild(b);
    }

    const btn = document.createElement("button");
    btn.className = "btn";
    btn.type = "button";
    btn.textContent = visit ? "Update visit" : "Visit";
    btn.addEventListener("click", () => openVisitDialog(p));

    right.appendChild(badges);
    right.appendChild(btn);

    top.appendChild(left);
    top.appendChild(right);

    el.appendChild(top);

    el.addEventListener("click", (e) => {
      if (e.target === btn) return;
      openShopDialog(p);
    });

    container.appendChild(el);
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderPassport() {
  const state = loadState();
  const visits = Object.values(state.visitsByPlaceId);
  visits.sort((a, b) => (a.visitedAt < b.visitedAt ? 1 : -1));

  const container = $("passport");
  container.innerHTML = "";

  if (!visits.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No visits yet. Tap Visit on a shop to add one.";
    container.appendChild(empty);
    return;
  }

  for (const v of visits) {
    const row = document.createElement("div");
    row.className = "visit";

    const photo = document.createElement("div");
    photo.className = "visit__photo";

    if (v.photoDataUrl) {
      const img = document.createElement("img");
      img.alt = v.placeName || "Photo";
      img.src = v.photoDataUrl;
      photo.appendChild(img);
    } else {
      const span = document.createElement("div");
      span.className = "muted";
      span.textContent = "No photo";
      photo.appendChild(span);
    }

    const body = document.createElement("div");
    body.className = "visit__body";

    row.addEventListener("click", (e) => {
      if (e.target === btnEdit || e.target === btnDelete) return;
      const p = nearbyPlaces.find((x) => x.place_id === v.placeId) || {
        place_id: v.placeId,
        name: v.placeName,
        vicinity: v.placeAddress,
      };
      openShopDialog(p);
    });

    const title = document.createElement("div");
    title.style.fontWeight = "700";
    title.textContent = v.placeName || "Coffee shop";

    const meta = document.createElement("div");
    meta.className = "muted";
    const date = v.visitedAt ? new Date(v.visitedAt) : null;
    meta.textContent = [
      v.rating ? `Rating: ${v.rating}★` : "Rating: –",
      date && !Number.isNaN(date.valueOf()) ? date.toLocaleString() : null,
      v.placeAddress || null,
    ]
      .filter(Boolean)
      .join(" · ");

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "10px";
    actions.style.marginTop = "6px";

    const btnEdit = document.createElement("button");
    btnEdit.className = "btn btn--ghost";
    btnEdit.type = "button";
    btnEdit.textContent = "Edit";
    btnEdit.addEventListener("click", () => {
      const p = nearbyPlaces.find((x) => x.place_id === v.placeId) || {
        place_id: v.placeId,
        name: v.placeName,
        vicinity: v.placeAddress,
      };
      openVisitDialog(p);
    });

    const btnDelete = document.createElement("button");
    btnDelete.className = "btn btn--danger";
    btnDelete.type = "button";
    btnDelete.textContent = "Delete";
    btnDelete.addEventListener("click", () => {
      const next = loadState();
      delete next.visitsByPlaceId[v.placeId];
      saveState(next);
      renderPassport();
      renderShops();
    });

    actions.appendChild(btnEdit);
    actions.appendChild(btnDelete);

    body.appendChild(title);
    body.appendChild(meta);
    body.appendChild(actions);

    row.appendChild(photo);
    row.appendChild(body);
    container.appendChild(row);
  }
}

function openVisitDialog(place) {
  pendingVisit = place;
  const state = loadState();
  const existing = state.visitsByPlaceId[place.place_id] || null;

  $("visitTitle").textContent = place.name || "Visit";
  $("rating").value = existing && existing.rating ? String(existing.rating) : "";
  $("photo").value = "";
  $("visitDialog").showModal();
}

function haversineMeters(a, b) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const q = s1 * s1 + Math.cos(lat1) * Math.cos(lat2) * s2 * s2;
  const c = 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
  return R * c;
}

async function saveVisitFromDialog() {
  if (!pendingVisit) return;

  const ratingRaw = $("rating").value;
  const rating = ratingRaw ? Number(ratingRaw) : null;

  const file = $("photo").files && $("photo").files[0] ? $("photo").files[0] : null;
  let photoDataUrl = null;

  try {
    photoDataUrl = await fileToDataUrl(file, { maxBytes: 4_500_000 });
  } catch (e) {
    alert(e instanceof Error ? e.message : "Could not save photo.");
    return;
  }

  const state = loadState();
  const prev = state.visitsByPlaceId[pendingVisit.place_id];

  state.visitsByPlaceId[pendingVisit.place_id] = {
    placeId: pendingVisit.place_id,
    placeName: pendingVisit.name || "Coffee shop",
    placeAddress: pendingVisit.vicinity || "",
    rating: rating && rating >= 1 && rating <= 5 ? rating : null,
    photoDataUrl: photoDataUrl || (prev ? prev.photoDataUrl : null),
    visitedAt: prev && prev.visitedAt ? prev.visitedAt : nowIso(),
    updatedAt: nowIso(),
  };

  saveState(state);
  renderShops();
  renderPassport();
}

function exportPassport() {
  const state = loadState();
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "coffee-passport.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function clearPassport() {
  const ok = confirm("Clear all visits on this device?");
  if (!ok) return;
  saveState({ visitsByPlaceId: {} });
  renderPassport();
  renderShops();
}

function initMap() {
  map = new google.maps.Map($("map"), {
    center: currentPosition,
    zoom: 14,
    mapId: undefined,
    streetViewControl: false,
    fullscreenControl: false,
    mapTypeControl: false,
  });

  infoWindow = new google.maps.InfoWindow();

  userMarker = new google.maps.Marker({
    map,
    position: currentPosition,
    title: "You are here",
    clickable: false,
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      fillColor: "#c8a06a",
      fillOpacity: 1,
      strokeColor: "#ffffff",
      strokeOpacity: 0.6,
      strokeWeight: 2,
      scale: 7,
    },
  });
}

function clearPlaceMarkers() {
  for (const m of placeMarkers) m.setMap(null);
  placeMarkers = [];
}

async function fetchNearbyCoffee() {
  if (!currentPosition) return;
  const apiKey = getApiKey();
  if (!apiKey) return;

  setLocationStatus("Searching nearby coffee…");
  $("btnRefresh").disabled = true;

  try {
    const radiusMeters = 2500;
    const body = {
      includedTypes: ["cafe"],
      maxResultCount: 20,
      rankPreference: "DISTANCE",
      locationRestriction: {
        circle: {
          center: { latitude: currentPosition.lat, longitude: currentPosition.lng },
          radius: radiusMeters,
        },
      },
    };

    const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `Places request failed (${res.status}).`);
    }

    const data = await res.json();
    const places = Array.isArray(data && data.places) ? data.places : [];

    const origin = { lat: currentPosition.lat, lng: currentPosition.lng };
    nearbyPlaces = places
      .map((p) => {
        const loc = p && p.location ? { lat: p.location.latitude, lng: p.location.longitude } : null;
        const d = loc ? haversineMeters(origin, loc) : null;
        return {
          place_id: p.id,
          name: p.displayName && p.displayName.text ? p.displayName.text : "Coffee shop",
          vicinity: p.formattedAddress || "",
          rating: typeof p.rating === "number" ? p.rating : undefined,
          user_ratings_total: typeof p.userRatingCount === "number" ? p.userRatingCount : undefined,
          geometry: loc
            ? {
                location: {
                  lat: () => loc.lat,
                  lng: () => loc.lng,
                },
              }
            : undefined,
          _distanceMeters: d,
        };
      })
      .filter((p) => p.place_id)
      .sort((a, b) => {
        const da = typeof a._distanceMeters === "number" ? a._distanceMeters : Number.POSITIVE_INFINITY;
        const db = typeof b._distanceMeters === "number" ? b._distanceMeters : Number.POSITIVE_INFINITY;
        return da - db;
      })
      .slice(0, 20);

    $("btnRefresh").disabled = false;
    setLocationStatus(`Found ${nearbyPlaces.length} coffee shops nearby.`);
    renderShops();

    if (map) {
      clearPlaceMarkers();
      const bounds = new google.maps.LatLngBounds();
      bounds.extend(currentPosition);

      for (const p of nearbyPlaces) {
        if (!p.geometry || !p.geometry.location) continue;
        const pos = { lat: p.geometry.location.lat(), lng: p.geometry.location.lng() };
        bounds.extend(pos);
        const marker = new google.maps.Marker({
          map,
          position: pos,
          title: p.name,
        });
        marker.addListener("click", () => {
          infoWindow.setContent(`<div style=\"font-weight:600\">${escapeHtml(p.name || "Coffee shop")}</div><div>${escapeHtml(
            p.vicinity || ""
          )}</div>`);
          infoWindow.open({ map, anchor: marker });
        });
        placeMarkers.push(marker);
      }

      map.fitBounds(bounds);
    }
  } catch (e) {
    $("btnRefresh").disabled = false;
    nearbyPlaces = [];
    setLocationStatus(e instanceof Error ? e.message : "Could not load nearby cafes.");
    renderShops();
  }
}

async function bootstrap() {
  $("btnSettings").addEventListener("click", openSettings);
  $("btnPassport").addEventListener("click", togglePassport);
  $("btnRefresh").addEventListener("click", () => {
    if (!getApiKey()) {
      openSettings();
      return;
    }
    fetchNearbyCoffee();
  });

  $("btnShopVisit").addEventListener("click", () => {
    if (!pendingShop) return;
    openVisitDialog(pendingShop);
  });

  $("btnShopShowOnMap").addEventListener("click", () => {
    if (!pendingShop || !pendingShop.geometry || !pendingShop.geometry.location || !map) return;
    $("shopDialog").close();
    map.panTo(pendingShop.geometry.location);
    map.setZoom(16);
    infoWindow.setContent(`<div style=\"font-weight:600\">${escapeHtml(pendingShop.name || "Coffee shop")}</div><div>${escapeHtml(
      pendingShop.vicinity || ""
    )}</div>`);
    infoWindow.setPosition(pendingShop.geometry.location);
    infoWindow.open({ map });
  });

  $("btnExport").addEventListener("click", exportPassport);
  $("btnClear").addEventListener("click", clearPassport);

  $("settingsForm").addEventListener("submit", (e) => {
    e.preventDefault();
    setApiKey($("apiKey").value);
    $("settingsDialog").close();
    start();
  });

  $("visitForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    await saveVisitFromDialog();
    $("visitDialog").close();
    if (pendingShop) {
      const st = loadState();
      const vis = pendingShop.place_id ? st.visitsByPlaceId[pendingShop.place_id] : null;
      $("btnShopVisit").textContent = vis ? "Update visit" : "Visit";
      renderShopGallery({ savedPhotoDataUrl: vis ? vis.photoDataUrl : null, placePhotos: [] });
    }
  });

  renderPassport();

  if (!navigator.geolocation) {
    setLocationStatus("Geolocation not available in this browser.");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      currentPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      setLocationStatus("Location acquired.");
      await start();
    },
    () => {
      setLocationStatus("Location permission denied.");
    },
    { enableHighAccuracy: true, timeout: 12000 }
  );
}

async function start() {
  const apiKey = getApiKey();
  if (!apiKey) {
    setLocationStatus("Add your Google Maps API key in Settings.");
    return;
  }

  if (!currentPosition) return;

  try {
    await ensureGmapsLoaded(apiKey);
  } catch (e) {
    setLocationStatus(e instanceof Error ? e.message : "Failed to load Google Maps.");
    return;
  }

  if (!map) initMap();
  fetchNearbyCoffee();
}

document.addEventListener("DOMContentLoaded", bootstrap);

const STORAGE_KEY = "coffee_passport_v1";
const GOOGLE_MAPS_API_KEY = "AIzaSyD5uOJLOyJjCU0hmOhIP08SrBEj7muK7Fc";

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
  return GOOGLE_MAPS_API_KEY;
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

function toLatLngLiteral(place) {
  if (!place) return null;

  if (place._latLng && typeof place._latLng.lat === "number" && typeof place._latLng.lng === "number") {
    return place._latLng;
  }

  const loc = place.geometry && place.geometry.location ? place.geometry.location : null;
  if (loc) {
    if (typeof loc.lat === "function" && typeof loc.lng === "function") {
      const lat = loc.lat();
      const lng = loc.lng();
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
    if (typeof loc.lat === "number" && typeof loc.lng === "number") {
      if (Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) return { lat: loc.lat, lng: loc.lng };
    }
  }

  if (place.location && typeof place.location.latitude === "number" && typeof place.location.longitude === "number") {
    const lat = place.location.latitude;
    const lng = place.location.longitude;
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }

  return null;
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
let rileyVerdicts = new Map();

function openPassport() {
  $("passportPanel").hidden = false;
  renderPassport();
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}

function setView(view) {
  const findView = $("findView");
  const passportPanel = $("passportPanel");
  const btnFind = $("btnFind");
  const btnPassport = $("btnPassport");

  const isPassport = view === "passport";

  if (findView) findView.hidden = isPassport;
  if (passportPanel) passportPanel.hidden = !isPassport;

  if (btnFind) btnFind.setAttribute("aria-current", isPassport ? "false" : "true");
  if (btnPassport) btnPassport.setAttribute("aria-current", isPassport ? "true" : "false");

  if (isPassport) {
    renderPassport();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else {
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (map && window.google && window.google.maps && window.google.maps.event) {
      setTimeout(() => {
        window.google.maps.event.trigger(map, "resize");
        if (currentPosition) map.setCenter(currentPosition);
      }, 0);
    }
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
  if (!apiKey) throw new Error("Missing Google Maps API key.");
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

  if (savedPhotoDataUrl) {
    const label = document.createElement("div");
    label.className = "gallery__label";
    label.textContent = "Your visit photo";

    const active = document.createElement("div");
    active.className = "gallery__active";
    const img = document.createElement("img");
    img.alt = "Visit photo";
    img.loading = "eager";
    img.src = savedPhotoDataUrl;
    active.appendChild(img);

    el.appendChild(label);
    el.appendChild(active);
  }

  const placeUrls = [];
  if (Array.isArray(placePhotos)) {
    for (const p of placePhotos) {
      if (!p || !p.name) continue;
      const u = placePhotoMediaUrl(p.name, { maxWidthPx: 900, maxHeightPx: 900 });
      if (u) placeUrls.push(u);
      if (placeUrls.length >= 6) break;
    }
  }

  const placeLabel = document.createElement("div");
  placeLabel.className = "gallery__label";
  placeLabel.textContent = "Coffee shop photos";
  el.appendChild(placeLabel);

  if (!placeUrls.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No coffee shop photos available.";
    el.appendChild(empty);
    return;
  }

  let activeIndex = 0;

  const active = document.createElement("div");
  active.className = "gallery__active";
  const activeImg = document.createElement("img");
  activeImg.alt = "Coffee shop photo";
  activeImg.loading = "eager";
  activeImg.src = placeUrls[activeIndex];
  active.appendChild(activeImg);

  const thumbs = document.createElement("div");
  thumbs.className = "gallery__thumbs";

  const thumbButtons = [];

  const setActive = (idx) => {
    activeIndex = idx;
    activeImg.src = placeUrls[activeIndex];
    for (let i = 0; i < thumbButtons.length; i++) {
      thumbButtons[i].setAttribute("aria-current", i === activeIndex ? "true" : "false");
    }
  };

  placeUrls.forEach((src, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gallery__thumb";
    btn.setAttribute("aria-current", idx === activeIndex ? "true" : "false");
    btn.addEventListener("click", () => setActive(idx));

    const img = document.createElement("img");
    img.alt = "Thumbnail";
    img.loading = "lazy";
    img.src = src;
    btn.appendChild(img);

    thumbButtons.push(btn);
    thumbs.appendChild(btn);
  });

  el.appendChild(active);
  if (placeUrls.length > 1) el.appendChild(thumbs);
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
    if (details && details.location) {
      const lat = details.location.latitude;
      const lng = details.location.longitude;
      if (Number.isFinite(lat) && Number.isFinite(lng) && pendingShop) {
        pendingShop._latLng = { lat, lng };
      }
    }
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
    empty.textContent = "No coffee shops found yet... Hit that Refresh button! ☕✨";
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

    const btnVisit = document.createElement("button");
    btnVisit.className = "btn";
    btnVisit.type = "button";
    btnVisit.textContent = visit ? "Update visit" : "Visit";
    btnVisit.addEventListener("click", () => openVisitDialog(p));

    const btnRiley = document.createElement("button");
    btnRiley.className = "btnAskRiley";
    btnRiley.type = "button";
    btnRiley.textContent = "Ask Riley";
    btnRiley.addEventListener("click", (e) => {
      e.stopPropagation();
      showRileyVerdict(p);
    });

    right.appendChild(badges);
    right.appendChild(btnVisit);
    right.appendChild(btnRiley);

    top.appendChild(left);
    top.appendChild(right);

    el.appendChild(top);

    el.addEventListener("click", (e) => {
      if (e.target === btnVisit || e.target === btnRiley) return;
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

function getRileyVerdict() {
  const verdicts = [
    { type: "positive", photo: "happy", messages: [
      "Absolutely! The vibes are immaculate ☕",
      "5-star potential, trust me on this one 🌟",
      "This place is chef's kiss 👨‍🍳💋",
      "You'd be crazy NOT to go here! 🔥",
      "This is THE spot, no question ✨",
      "I'm getting major cozy energy from this place 🛋️",
      "10/10 would recommend, my coffee senses are tingling ☕",
      "This place just FEELS right, ya know? 💯"
    ]},
    { type: "negative", photo: "sad", messages: [
      "Ehh, skip this one unless you're desperate 😬",
      "I mean... if you REALLY want to... but why? 🤷",
      "Not feeling it tbh 😕",
      "There are better options nearby, I promise 📍",
      "My gut says pass on this one 🙅",
      "Meh energy detected 😑",
      "I've got a bad feeling about this one..."
    ]}
  ];

  const category = verdicts[Math.floor(Math.random() * verdicts.length)];
  const message = category.messages[Math.floor(Math.random() * category.messages.length)];
  
  return {
    type: category.type,
    photo: category.photo,
    message: message
  };
}

function getThinkingMessage() {
  const messages = [
    "Consulting the coffee gods...",
    "Analyzing vibes...",
    "Checking my gut feeling...",
    "Doing some serious thinking here...",
    "Hmm, let me ponder this...",
    "Tapping into my coffee expertise...",
    "Reading the tea leaves (jk it's coffee)...",
    "Computing the vibe check..."
  ];
  return messages[Math.floor(Math.random() * messages.length)];
}

function createConfetti() {
  const colors = ["#a855f7", "#ec4899", "#f97316", "#10b981", "#fbbf24"];
  const confettiCount = 30;
  
  for (let i = 0; i < confettiCount; i++) {
    setTimeout(() => {
      const confetti = document.createElement("div");
      confetti.className = "confetti";
      confetti.style.left = Math.random() * 100 + "vw";
      confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
      confetti.style.animationDelay = Math.random() * 0.5 + "s";
      confetti.style.animationDuration = (Math.random() * 2 + 2) + "s";
      document.body.appendChild(confetti);
      
      setTimeout(() => confetti.remove(), 3500);
    }, i * 30);
  }
}

async function showRileyVerdict(place) {
  const modal = $("rileyDialog");
  const containerEl = $("rileyVerdictContainer");
  
  containerEl.innerHTML = "";
  modal.showModal();

  const verdictContainer = document.createElement("div");
  verdictContainer.className = "rileyVerdict";

  const content = document.createElement("div");
  content.className = "rileyVerdict__content";

  const photo = document.createElement("div");
  photo.className = "rileyVerdict__photo rileyVerdict__photo--thinking";
  const img = document.createElement("img");
  img.alt = "Riley thinking";
  img.src = "./riley-photos/thinking.jpg";
  let triedJpg = false;
  img.onerror = () => {
    if (!triedJpg) {
      triedJpg = true;
      img.src = "./riley-photos/thinking.svg";
    } else {
      img.style.display = "none";
      photo.textContent = "🤔";
      photo.style.display = "flex";
      photo.style.alignItems = "center";
      photo.style.justifyContent = "center";
      photo.style.fontSize = "32px";
    }
  };
  photo.appendChild(img);

  const text = document.createElement("div");
  text.className = "rileyVerdict__text";

  const label = document.createElement("div");
  label.className = "rileyVerdict__label";
  label.textContent = "Riley's verdict";

  const message = document.createElement("div");
  message.className = "rileyVerdict__message";
  message.textContent = getThinkingMessage();

  text.appendChild(label);
  text.appendChild(message);
  content.appendChild(photo);
  content.appendChild(text);
  verdictContainer.appendChild(content);
  containerEl.appendChild(verdictContainer);

  await new Promise(resolve => setTimeout(resolve, 1500 + Math.random() * 1000));

  const verdict = getRileyVerdict();
  rileyVerdicts.set(place.place_id, verdict);

  photo.classList.remove("rileyVerdict__photo--thinking");
  img.src = `./riley-photos/${verdict.photo}.jpg`;
  let triedVerdictJpg = false;
  img.onerror = () => {
    if (!triedVerdictJpg) {
      triedVerdictJpg = true;
      img.src = `./riley-photos/${verdict.photo}.svg`;
    }
  };
  img.alt = `Riley ${verdict.photo}`;
  message.textContent = verdict.message;
  verdictContainer.className = `rileyVerdict rileyVerdict--${verdict.type}`;

  if (verdict.type === "positive") {
    createConfetti();
  }
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
    empty.textContent = "Your passport is empty! Time to start your coffee adventure! 🗺️☕";
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

    const title = document.createElement("div");
    title.style.fontWeight = "700";
    title.textContent = v.placeName || "Coffee shop";

    const stars = document.createElement("div");
    stars.className = "stars stars--small";
    const rating = v.rating && v.rating >= 1 && v.rating <= 5 ? v.rating : 0;
    for (let i = 1; i <= 5; i++) {
      const s = document.createElement("span");
      s.className = `star star--small${i <= rating ? " isOn" : ""}`;
      s.textContent = "★";
      stars.appendChild(s);
    }

    body.appendChild(title);
    body.appendChild(stars);

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
  syncStarRatingUI();
  $("photo").value = "";
  const photoName = $("photoName");
  if (photoName) photoName.textContent = "No file selected";
  $("visitDialog").showModal();
}

function syncStarRatingUI() {
  const valueRaw = $("rating").value;
  const value = valueRaw ? Number(valueRaw) : 0;
  const stars = document.querySelectorAll(".stars .star");
  for (const el of stars) {
    const v = Number(el.getAttribute("data-value"));
    const on = Number.isFinite(v) && v <= value;
    el.classList.toggle("isOn", on);
    el.setAttribute("aria-checked", v === value ? "true" : "false");
  }
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
  
  if (rating === 5) {
    createConfetti();
  }
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

  setLocationStatus("Hunting for the best coffee vibes... ☕🔍");
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
    const funMessages = [
      `Found ${nearbyPlaces.length} coffee spots! Let's explore! 🎉`,
      `${nearbyPlaces.length} cafes discovered! Time to caffeinate! ☕`,
      `${nearbyPlaces.length} coffee shops nearby - the adventure begins! 🗺️`,
      `Woohoo! ${nearbyPlaces.length} places to get your coffee fix! 🎊`
    ];
    setLocationStatus(funMessages[Math.floor(Math.random() * funMessages.length)]);
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
          infoWindow.setContent(
            `<div class=\"iw\"><div class=\"iw__title\">${escapeHtml(p.name || "Coffee shop")}</div><div class=\"iw__addr\">${escapeHtml(
              p.vicinity || ""
            )}</div></div>`
          );
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
  $("btnFind").addEventListener("click", () => setView("find"));
  $("btnPassport").addEventListener("click", () => setView("passport"));
  $("btnRefresh").addEventListener("click", () => {
    fetchNearbyCoffee();
  });

  $("btnShopVisit").addEventListener("click", () => {
    if (!pendingShop) return;
    $("shopDialog").close();
    openVisitDialog(pendingShop);
  });

  $("btnShopAskRiley").addEventListener("click", () => {
    if (!pendingShop) return;
    showRileyVerdict(pendingShop);
  });

  $("btnShopShowOnMap").addEventListener("click", () => {
    if (!pendingShop || !map) return;
    const pos = toLatLngLiteral(pendingShop);
    if (!pos) return;
    $("shopDialog").close();
    setView("find");
    const mapEl = $("map");
    if (mapEl) {
      mapEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    requestAnimationFrame(() => {
      if (window.google && window.google.maps && window.google.maps.event) {
        window.google.maps.event.trigger(map, "resize");
      }
      map.panTo(pos);
      map.setZoom(16);
      infoWindow.setContent(
        `<div class=\"iw\"><div class=\"iw__title\">${escapeHtml(
          pendingShop.name || "Coffee shop"
        )}</div><div class=\"iw__addr\">${escapeHtml(pendingShop.vicinity || "")}</div></div>`
      );
      infoWindow.setPosition(pos);
      infoWindow.open({ map });
    });
  });

  $("btnExport").addEventListener("click", exportPassport);
  $("btnClear").addEventListener("click", clearPassport);

  $("visitForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    await saveVisitFromDialog();
    $("visitDialog").close();
    if (pendingShop) {
      const st = loadState();
      const vis = pendingShop.place_id ? st.visitsByPlaceId[pendingShop.place_id] : null;
      if ($("shopDialog").open) {
        $("btnShopVisit").textContent = vis ? "Update visit" : "Visit";
        renderShopGallery({ savedPhotoDataUrl: vis ? vis.photoDataUrl : null, placePhotos: [] });
      }
    }
  });

  const stars = document.querySelectorAll(".stars .star");
  for (const el of stars) {
    el.addEventListener("click", () => {
      const v = Number(el.getAttribute("data-value"));
      $("rating").value = Number.isFinite(v) ? String(v) : "";
      syncStarRatingUI();
    });
  }

  $("photo").addEventListener("change", () => {
    const photoName = $("photoName");
    if (!photoName) return;
    const file = $("photo").files && $("photo").files[0] ? $("photo").files[0] : null;
    photoName.textContent = file ? file.name : "No file selected";
  });

  setView("find");

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
    setLocationStatus("Missing Google Maps API key.");
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

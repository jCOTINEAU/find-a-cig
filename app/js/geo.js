// Couche d'abstraction de géolocalisation (phase 2 du plan Android natif).
// Même interface pour la PWA (navigator.geolocation) et l'APK Capacitor
// (plugin background-geolocation → foreground service, GPS écran verrouillé).
// Fix normalisé partout : { lat, lon, acc, ts }.

function cap() { return typeof window !== 'undefined' ? window.Capacitor : undefined; }
export function isNative() {
  const c = cap();
  return !!(c && typeof c.isNativePlatform === 'function' && c.isNativePlatform());
}
function nativeBG() {
  return isNative() ? window.__CTA_NATIVE__?.BackgroundGeolocation : null;
}

const normWeb = p => ({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, ts: p.timestamp });

// Suivi continu. En natif, lance un foreground service (notification persistante)
// qui garde le GPS actif même écran verrouillé / app en arrière-plan.
// Renvoie un "handle" opaque à passer à clearWatch().
export async function watch(onFix, onError) {
  const BG = nativeBG();
  if (BG) {
    const id = await BG.addWatcher(
      {
        backgroundMessage: "Suivi de la collecte en cours — touche pour revenir",
        backgroundTitle: "Clean Them All",
        requestPermissions: true,
        stale: false,
        distanceFilter: 5,
      },
      (location, error) => {
        if (error) { onError?.(error); return; }
        if (location) {
          onFix({ lat: location.latitude, lon: location.longitude, acc: location.accuracy, ts: location.time ?? Date.now() });
        }
      },
    );
    return { native: true, id };
  }
  if (!('geolocation' in navigator)) { onError?.(new Error('no geolocation')); return null; }
  const wid = navigator.geolocation.watchPosition(
    p => onFix(normWeb(p)),
    e => onError?.(e),
    { enableHighAccuracy: true, maximumAge: 0 },
  );
  return { native: false, id: wid };
}

export async function clearWatch(handle) {
  if (!handle) return;
  if (handle.native) {
    try { await nativeBG()?.removeWatcher({ id: handle.id }); } catch { /* déjà arrêté */ }
  } else {
    navigator.geolocation.clearWatch(handle.id);
  }
}

// Position ponctuelle (rafraîchissement d'un point / centrage carte). Utilisée au
// premier plan uniquement → l'API web du WebView suffit dans les deux cas.
export function getCurrent(onFix, onError, opts = {}) {
  if (!('geolocation' in navigator)) { onError?.(new Error('no geolocation')); return; }
  navigator.geolocation.getCurrentPosition(
    p => onFix(normWeb(p)),
    e => onError?.(e),
    { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0, ...opts },
  );
}

// layout.js - versioned, debounced layout store for drag-and-drop customization
(function () {
  const LAYOUT_KEY = 'boing-layout';
  const LAYOUT_VERSION = 1;
  const DEBOUNCE_MS = 300;

  const registry = new Map(); // id -> { id, zone, order, visible, w, h, resizable, movable, label }
  const defaults = [];

  let state = null;
  let saveTimer = null;
  const listeners = new Set();

  function defaultState() {
    return {
      version: LAYOUT_VERSION,
      editMode: false,
      items: defaults.map((d, i) => ({
        id: d.id,
        zone: d.zone,
        order: d.order != null ? d.order : i,
        visible: d.visible !== false,
        w: d.w || 1,
        h: d.h || 1,
      })),
    };
  }

  function normalize(loaded) {
    if (!loaded || typeof loaded !== 'object' || loaded.version !== LAYOUT_VERSION) {
      return defaultState();
    }
    const items = Array.isArray(loaded.items) ? loaded.items : [];
    // merge with registry defaults for any missing items
    const byId = new Map(items.map(it => [it.id, it]));
    const merged = defaults.map((d, i) => {
      const ex = byId.get(d.id);
      return {
        id: d.id,
        zone: (ex && ex.zone) || d.zone,
        order: (ex && typeof ex.order === 'number') ? ex.order : (d.order != null ? d.order : i),
        visible: (ex && typeof ex.visible === 'boolean') ? ex.visible : (d.visible !== false),
        w: (ex && typeof ex.w === 'number') ? ex.w : (d.w || 1),
        h: (ex && typeof ex.h === 'number') ? ex.h : (d.h || 1),
      };
    });
    return { version: LAYOUT_VERSION, editMode: !!loaded.editMode, items: merged };
  }

  function load() {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      state = normalize(raw ? JSON.parse(raw) : null);
    } catch (e) {
      state = defaultState();
    }
    notify();
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(state)); } catch (e) {}
    }, DEBOUNCE_MS);
  }

  function notify() { listeners.forEach(fn => { try { fn(state); } catch (e) {} }); }

  function get() { return state; }
  function setEditMode(v) { state.editMode = !!v; notify(); scheduleSave(); }
  function isEdit() { return !!(state && state.editMode); }

  function getItem(id) { return state.items.find(it => it.id === id); }
  function getReg(id) { return registry.get(id); }

  function register(def) {
    registry.set(def.id, def);
    if (!defaults.find(d => d.id === def.id)) defaults.push(def);
    // ensure item exists in state
    if (state && !state.items.find(it => it.id === def.id)) {
      state.items.push({ id: def.id, zone: def.zone, order: def.order != null ? def.order : state.items.length, visible: def.visible !== false, w: def.w || 1, h: def.h || 1 });
      scheduleSave();
    }
  }

  function move(id, toZone, toIndex) {
    const it = getItem(id);
    if (!it) return;
    const reg = getReg(id);
    if (reg && reg.movable === false) return;
    it.zone = toZone;
    // reorder within target zone
    const zoneItems = state.items.filter(x => x.zone === toZone && x.id !== id).sort((a,b) => a.order - b.order);
    const idx = Math.max(0, Math.min(toIndex, zoneItems.length));
    zoneItems.splice(idx, 0, it);
    zoneItems.forEach((x, i) => { x.order = i; });
    // renumber other zones too (keep stable)
    state.items.forEach(x => { if (x.zone !== toZone) { /* leave */ } });
    // recompute orders for all zones
    const zones = new Set(state.items.map(x => x.zone));
    zones.forEach(z => {
      state.items.filter(x => x.zone === z).sort((a,b)=>a.order-b.order).forEach((x,i)=>{ x.order=i; });
    });
    notify(); scheduleSave();
    announce('Moved ' + (reg ? reg.label || id : id));
  }

  function resize(id, w, h) {
    const it = getItem(id);
    const reg = getReg(id);
    if (!it || !reg || !reg.resizable) return;
    const minW = reg.minW || 1, maxW = reg.maxW || 6;
    const minH = reg.minH || 1, maxH = reg.maxH || 6;
    it.w = Math.max(minW, Math.min(maxW, w));
    it.h = Math.max(minH, Math.min(maxH, h));
    notify(); scheduleSave();
  }

  function toggleVisible(id, visible) {
    const it = getItem(id);
    if (!it) return;
    it.visible = !!visible;
    notify(); scheduleSave();
  }

  function reset() {
    state = defaultState();
    // clear any stored
    try { localStorage.removeItem(LAYOUT_KEY); } catch (e) {}
    notify();
    announce('Layout reset to default');
  }

  // ARIA live region
  let live = null;
  function ensureLive() {
    if (live) return live;
    live = document.createElement('div');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    live.className = 'sr-only';
    document.body.appendChild(live);
    return live;
  }
  function announce(msg) {
    const l = ensureLive();
    l.textContent = '';
    setTimeout(() => { l.textContent = msg; }, 50);
  }

  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // public API
  window.layoutStore = {
    init: load,
    register,
    get: get,
    subscribe,
    setEditMode,
    isEdit,
    move,
    resize,
    toggleVisible,
    reset,
    announce,
    version: LAYOUT_VERSION,
  };

  // load on script load
  load();
})();

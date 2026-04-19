/* Shadowquill VTT — single-file React app
 * - Dual-mode (DM / Player) with strict permission separation
 * - PeerJS WebRTC sync (free public broker — no backend required)
 * - LocalStorage persistence + Export/Import JSON
 */
const { useState, useEffect, useRef, useReducer, useMemo, useCallback, createContext, useContext } = React;

// ====================================================================
// CONSTANTS
// ====================================================================
const STORAGE_KEY = 'shadowquill.session.v1';
const AUTH_KEY = 'shadowquill.auth.v1';
const PEER_PREFIX = 'shadowquill-';
// Simple password for DM mode (placeholder — swap with real auth for production)
const DM_PASSWORD = 'dragon';

const CONDITIONS = [
  'Blinded','Charmed','Deafened','Frightened','Grappled',
  'Incapacitated','Invisible','Paralyzed','Petrified','Poisoned',
  'Prone','Restrained','Stunned','Unconscious','Exhausted',
  'Concentrating','Raging','Blessed','Hasted','Dead'
];

const CONDITION_COLORS = {
  'Poisoned': '#6b8e3f', 'Stunned': '#c9b03a', 'Blinded': '#444',
  'Paralyzed': '#7a4bc4', 'Charmed': '#c46ab8', 'Frightened': '#b56a3a',
  'Prone': '#6b7280', 'Restrained': '#8b5a2b', 'Unconscious': '#4a4a6a',
  'Dead': '#8b2020', 'Invisible': '#4a7cbd', 'Blessed': '#d4a574',
  'Concentrating': '#9b6ac4', 'Raging': '#c43e3e', 'Hasted': '#d4a574',
};

const ENTITY_TYPES = ['PC', 'Monster', 'NPC'];

const DEFAULT_COLORS = {
  'PC': '#4a7cbd',
  'Monster': '#8b2020',
  'NPC': '#d4a574',
};

// ====================================================================
// UTILITIES
// ====================================================================
const uid = (prefix = '') => prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const roll = (sides) => 1 + Math.floor(Math.random() * sides);
const modFor = (stat) => Math.floor((stat - 10) / 2);

const deepClone = (obj) => JSON.parse(JSON.stringify(obj));

const downloadJson = (data, filename) => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
};

const pickFile = (accept = 'application/json') => new Promise((res) => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return res(null);
    const reader = new FileReader();
    reader.onload = () => res({ file, content: reader.result });
    reader.readAsText(file);
  };
  input.click();
});

const pickImage = () => new Promise((res) => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return res(null);
    const reader = new FileReader();
    reader.onload = () => res(reader.result);
    reader.readAsDataURL(file);
  };
  input.click();
});

// ====================================================================
// DEFAULT STATE
// ====================================================================
const makeDefaultState = () => {
  const mapId = uid('map_');
  return {
    entities: {},
    maps: {
      [mapId]: {
        id: mapId,
        name: 'The World',
        type: 'world',
        parentId: null,
        imageUrl: null,
        notes: '',
        viewport: { x: 0, y: 0, zoom: 1 }
      }
    },
    tokens: {},
    initiative: { active: false, entries: [], turn: 0, round: 1 },
    presets: {},
    currentMapId: mapId,
    forcedView: null,
    playerMapOverride: null, // player-chosen map when not forced
    claimedPCs: {}, // peerId -> entityId
  };
};

const makeEntity = (overrides = {}) => ({
  id: uid('ent_'),
  name: 'Unnamed',
  type: 'PC',
  color: DEFAULT_COLORS['PC'],
  ac: 10,
  hp: { current: 10, max: 10 },
  speed: 30,
  initBonus: 0,
  passivePerception: 10,
  conditions: [],
  notes: '',
  stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
  class: '', level: 1, playerName: '',
  cr: '1/4', abilities: '',
  faction: '', role: '',
  ...overrides,
});

// ====================================================================
// STATE REDUCER
// ====================================================================
function reducer(state, action) {
  switch (action.type) {
    case 'HYDRATE': return { ...state, ...action.payload };
    case 'REPLACE': return action.payload;

    // Entities
    case 'ENTITY_UPSERT':
      return { ...state, entities: { ...state.entities, [action.entity.id]: action.entity } };
    case 'ENTITY_DELETE': {
      const { [action.id]: _removed, ...rest } = state.entities;
      const tokens = Object.fromEntries(Object.entries(state.tokens).filter(([_, t]) => t.entityId !== action.id));
      const initEntries = state.initiative.entries.filter(e => e.entityId !== action.id);
      const claimedPCs = Object.fromEntries(Object.entries(state.claimedPCs).filter(([_, v]) => v !== action.id));
      return {
        ...state,
        entities: rest,
        tokens,
        initiative: { ...state.initiative, entries: initEntries },
        claimedPCs,
      };
    }
    case 'ENTITY_HP_ADJUST': {
      const e = state.entities[action.id];
      if (!e) return state;
      const cur = clamp(e.hp.current + action.delta, 0, e.hp.max);
      const updated = { ...e, hp: { ...e.hp, current: cur } };
      if (cur === 0 && !updated.conditions.includes('Unconscious')) {
        updated.conditions = [...updated.conditions, 'Unconscious'];
      }
      return { ...state, entities: { ...state.entities, [action.id]: updated } };
    }
    case 'ENTITY_TOGGLE_CONDITION': {
      const e = state.entities[action.id];
      if (!e) return state;
      const has = e.conditions.includes(action.condition);
      return {
        ...state,
        entities: {
          ...state.entities,
          [action.id]: {
            ...e,
            conditions: has
              ? e.conditions.filter(c => c !== action.condition)
              : [...e.conditions, action.condition]
          }
        }
      };
    }

    // Maps
    case 'MAP_UPSERT':
      return { ...state, maps: { ...state.maps, [action.map.id]: action.map } };
    case 'MAP_DELETE': {
      if (Object.keys(state.maps).length <= 1) return state;
      const { [action.id]: _r, ...rest } = state.maps;
      const tokens = Object.fromEntries(Object.entries(state.tokens).filter(([_, t]) => t.mapId !== action.id));
      let currentMapId = state.currentMapId;
      if (currentMapId === action.id) currentMapId = Object.keys(rest)[0];
      // reparent children
      const maps = Object.fromEntries(Object.entries(rest).map(([k, v]) => [
        k, v.parentId === action.id ? { ...v, parentId: null } : v
      ]));
      return { ...state, maps, tokens, currentMapId };
    }
    case 'MAP_SWITCH':
      return { ...state, currentMapId: action.id };
    case 'MAP_VIEWPORT':
      return {
        ...state,
        maps: {
          ...state.maps,
          [action.id]: { ...state.maps[action.id], viewport: action.viewport }
        }
      };

    // Tokens
    case 'TOKEN_PLACE': {
      // prevent duplicate placement per map per entity
      const existing = Object.values(state.tokens).find(
        t => t.entityId === action.token.entityId && t.mapId === action.token.mapId
      );
      if (existing) return state;
      return { ...state, tokens: { ...state.tokens, [action.token.id]: action.token } };
    }
    case 'TOKEN_MOVE': {
      const t = state.tokens[action.id];
      if (!t) return state;
      return { ...state, tokens: { ...state.tokens, [action.id]: { ...t, x: action.x, y: action.y } } };
    }
    case 'TOKEN_REMOVE': {
      const { [action.id]: _r, ...rest } = state.tokens;
      return { ...state, tokens: rest };
    }
    case 'TOKEN_VISIBILITY': {
      const t = state.tokens[action.id];
      if (!t) return state;
      return { ...state, tokens: { ...state.tokens, [action.id]: { ...t, visible: action.visible } } };
    }
    case 'TOKEN_REVEAL_ALL_ON_MAP': {
      const tokens = Object.fromEntries(Object.entries(state.tokens).map(([k, t]) => [
        k, t.mapId === action.mapId ? { ...t, visible: action.visible } : t
      ]));
      return { ...state, tokens };
    }

    // Initiative
    case 'INIT_SET': return { ...state, initiative: action.initiative };
    case 'INIT_ADVANCE': {
      const { entries } = state.initiative;
      if (!entries.length) return state;
      const nextTurn = (state.initiative.turn + 1) % entries.length;
      const round = nextTurn === 0 ? state.initiative.round + 1 : state.initiative.round;
      return { ...state, initiative: { ...state.initiative, turn: nextTurn, round } };
    }

    // Presets
    case 'PRESET_SAVE':
      return { ...state, presets: { ...state.presets, [action.preset.id]: action.preset } };
    case 'PRESET_DELETE': {
      const { [action.id]: _r, ...rest } = state.presets;
      return { ...state, presets: rest };
    }

    // Forced view
    case 'FORCED_VIEW': return { ...state, forcedView: action.forcedView };

    // Player map override
    case 'PLAYER_MAP_OVERRIDE': return { ...state, playerMapOverride: action.mapId };

    // Claim
    case 'CLAIM_PC':
      return { ...state, claimedPCs: { ...state.claimedPCs, [action.peerId]: action.entityId } };
    case 'UNCLAIM_PC': {
      const { [action.peerId]: _r, ...rest } = state.claimedPCs;
      return { ...state, claimedPCs: rest };
    }

    default: return state;
  }
}

// ====================================================================
// SYNC (PeerJS)
// ====================================================================
class SyncManager {
  constructor({ mode, onStateUpdate, onPlayerAction, onStatusChange, onPeerListChange, onError }) {
    this.mode = mode;
    this.peer = null;
    this.roomCode = null;
    this.connections = new Map(); // for DM
    this.dmConnection = null; // for Player
    this.myPeerId = null;
    this.onStateUpdate = onStateUpdate;
    this.onPlayerAction = onPlayerAction;
    this.onStatusChange = onStatusChange;
    this.onPeerListChange = onPeerListChange;
    this.onError = onError;
    this.status = 'offline';
  }
  setStatus(s) {
    this.status = s;
    this.onStatusChange?.(s);
  }
  async hostSession(roomCode) {
    this.setStatus('connecting');
    this.roomCode = roomCode;
    try {
      this.peer = new Peer(PEER_PREFIX + roomCode);
      this.peer.on('open', (id) => {
        this.myPeerId = id;
        this.setStatus('live');
      });
      this.peer.on('connection', (conn) => {
        conn.on('open', () => {
          this.connections.set(conn.peer, conn);
          this.onPeerListChange?.(Array.from(this.connections.keys()));
        });
        conn.on('data', (data) => {
          if (data.type === 'player_action') this.onPlayerAction?.(data.payload, conn.peer);
        });
        conn.on('close', () => {
          this.connections.delete(conn.peer);
          this.onPeerListChange?.(Array.from(this.connections.keys()));
        });
        conn.on('error', () => {
          this.connections.delete(conn.peer);
          this.onPeerListChange?.(Array.from(this.connections.keys()));
        });
      });
      this.peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
          this.onError?.('Room code already in use. Pick another.');
          this.setStatus('error');
        } else {
          this.setStatus('error');
          this.onError?.(err.message || 'Connection error');
        }
      });
    } catch (err) {
      this.setStatus('error');
      this.onError?.(err.message);
    }
  }
  async joinSession(roomCode) {
    this.setStatus('connecting');
    this.roomCode = roomCode;
    try {
      this.peer = new Peer();
      this.peer.on('open', (id) => {
        this.myPeerId = id;
        const conn = this.peer.connect(PEER_PREFIX + roomCode, { reliable: true });
        this.dmConnection = conn;
        conn.on('open', () => {
          this.setStatus('live');
          conn.send({ type: 'hello', peerId: id });
        });
        conn.on('data', (data) => {
          if (data.type === 'state_update') this.onStateUpdate?.(data.payload);
        });
        conn.on('close', () => this.setStatus('offline'));
        conn.on('error', () => this.setStatus('error'));
      });
      this.peer.on('error', (err) => {
        this.setStatus('error');
        this.onError?.(err.message || 'Could not connect');
      });
    } catch (err) {
      this.setStatus('error');
      this.onError?.(err.message);
    }
  }
  broadcastState(state) {
    if (this.mode !== 'dm') return;
    const payload = { type: 'state_update', payload: state };
    for (const conn of this.connections.values()) {
      try { if (conn.open) conn.send(payload); } catch {}
    }
  }
  sendPlayerAction(action) {
    if (this.mode !== 'player' || !this.dmConnection?.open) return false;
    try {
      this.dmConnection.send({ type: 'player_action', payload: action });
      return true;
    } catch { return false; }
  }
  destroy() {
    try { this.peer?.destroy(); } catch {}
    this.peer = null;
    this.connections.clear();
    this.dmConnection = null;
    this.setStatus('offline');
  }
}

// ====================================================================
// VISIBILITY FILTER (what player can see)
// ====================================================================
function filterStateForPlayer(state, peerId) {
  // Only include tokens that are visible OR belong to PCs OR to the claimed PC
  const visibleTokens = {};
  const claimedEntityId = state.claimedPCs?.[peerId];

  Object.entries(state.tokens).forEach(([k, t]) => {
    const entity = state.entities[t.entityId];
    if (!entity) return;
    const isPC = entity.type === 'PC';
    const isOwnPC = claimedEntityId === entity.id;
    if (t.visible || isPC || isOwnPC) {
      visibleTokens[k] = t;
    }
  });

  // Filter initiative entries - only show PCs and visible entities
  const filteredInitEntries = state.initiative.entries.filter(e => {
    const entity = state.entities[e.entityId];
    if (!entity) return false;
    if (entity.type === 'PC') return true;
    // show if they have a visible token on current map
    return Object.values(state.tokens).some(t => t.entityId === entity.id && t.visible);
  });

  return {
    ...state,
    tokens: visibleTokens,
    initiative: { ...state.initiative, entries: filteredInitEntries },
  };
}

// ====================================================================
// TOAST SYSTEM
// ====================================================================
const ToastContext = createContext(null);

function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, type = 'info', duration = 3000) => {
    const id = uid('t');
    setToasts((curr) => [...curr, { id, message, type }]);
    setTimeout(() => setToasts((curr) => curr.filter(t => t.id !== id)), duration);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`}>{t.message}</div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
const useToast = () => useContext(ToastContext);

// ====================================================================
// AUTH SCREEN
// ====================================================================
function AuthScreen({ onAuth }) {
  const [tab, setTab] = useState('dm');
  const [password, setPassword] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [error, setError] = useState('');

  const handleDM = () => {
    if (password !== DM_PASSWORD) {
      setError('Incorrect passphrase.');
      return;
    }
    const code = roomCode.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || 'table-' + Math.random().toString(36).slice(2, 6);
    onAuth({ mode: 'dm', roomCode: code });
  };

  const handlePlayer = () => {
    if (!roomCode.trim()) { setError('Enter a room code.'); return; }
    if (!playerName.trim()) { setError('Choose a display name.'); return; }
    onAuth({
      mode: 'player',
      roomCode: roomCode.trim().toLowerCase(),
      playerName: playerName.trim()
    });
  };

  const handleLocal = () => {
    onAuth({ mode: 'dm', roomCode: null, local: true });
  };

  return (
    <div className="auth-screen">
      <div className="auth-card slide-up">
        <div className="auth-title">Shadowquill</div>
        <div className="auth-subtitle">— a virtual tabletop for the weary gamesmaster —</div>

        <div className="auth-tab-row">
          <div className={`auth-tab ${tab === 'dm' ? 'active' : ''}`} onClick={() => { setTab('dm'); setError(''); }}>
            ⚔ Dungeon Master
          </div>
          <div className={`auth-tab ${tab === 'player' ? 'active' : ''}`} onClick={() => { setTab('player'); setError(''); }}>
            ⌂ Player
          </div>
        </div>

        {tab === 'dm' ? (
          <>
            <div className="auth-field">
              <label>Passphrase</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter the arcane word…" autoFocus
                onKeyDown={e => e.key === 'Enter' && handleDM()} />
              <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginTop: 4 }}>
                Default passphrase: <kbd>dragon</kbd> — edit <code>DM_PASSWORD</code> in <code>app.js</code>
              </div>
            </div>
            <div className="auth-field">
              <label>Room Code (optional)</label>
              <input value={roomCode} onChange={e => setRoomCode(e.target.value)} placeholder="e.g. curse-of-strahd"
                onKeyDown={e => e.key === 'Enter' && handleDM()} />
              <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginTop: 4 }}>
                Share with players so they may join.
              </div>
            </div>
            {error && <div style={{ color: 'var(--blood-bright)', fontSize: 12, marginBottom: 12 }}>{error}</div>}
            <button className="btn primary" style={{ width: '100%', justifyContent: 'center', padding: '12px' }} onClick={handleDM}>
              Open the Session
            </button>
            <div className="hr" />
            <button className="btn ghost" style={{ width: '100%', justifyContent: 'center' }} onClick={handleLocal}>
              ⚐ Local-only mode (no sync)
            </button>
          </>
        ) : (
          <>
            <div className="auth-field">
              <label>Room Code</label>
              <input value={roomCode} onChange={e => setRoomCode(e.target.value)} placeholder="e.g. curse-of-strahd" autoFocus
                onKeyDown={e => e.key === 'Enter' && handlePlayer()} />
            </div>
            <div className="auth-field">
              <label>Your Name</label>
              <input value={playerName} onChange={e => setPlayerName(e.target.value)} placeholder="e.g. Elara"
                onKeyDown={e => e.key === 'Enter' && handlePlayer()} />
            </div>
            {error && <div style={{ color: 'var(--blood-bright)', fontSize: 12, marginBottom: 12 }}>{error}</div>}
            <button className="btn primary" style={{ width: '100%', justifyContent: 'center', padding: '12px' }} onClick={handlePlayer}>
              Join the Table
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ====================================================================
// TOKEN COMPONENT
// ====================================================================
function TokenView({ token, entity, isCurrent, isSelected, canDrag, onStartDrag, onDoubleClick, onContextMenu, showLabel }) {
  if (!entity) return null;
  const typeClass = entity.type === 'PC' ? 'pc' : entity.type === 'Monster' ? 'monster' : 'npc';
  const hpPct = entity.hp.max > 0 ? (entity.hp.current / entity.hp.max) * 100 : 0;
  const hpClass = hpPct <= 25 ? 'critical' : hpPct <= 50 ? 'low' : '';
  const initial = (entity.name || '?').slice(0, 1).toUpperCase();

  const onPointerDown = (e) => {
    if (e.button === 2) return;
    if (canDrag) {
      e.stopPropagation();
      onStartDrag?.(e);
    }
  };
  const onContext = (e) => {
    if (onContextMenu) { e.preventDefault(); onContextMenu(e); }
  };

  const classes = [
    'token',
    !token.visible ? 'hidden-token' : '',
    isCurrent ? 'current-turn' : '',
    isSelected ? 'selected' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={classes}
      data-tok={token.id}
      style={{ left: token.x - 22, top: token.y - 22 }}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick?.(e); }}
      onContextMenu={onContext}
      onTouchStart={(e) => { if (canDrag) { e.stopPropagation(); onStartDrag?.(e); }}}
    >
      {entity.hp.max > 0 && (
        <div className="token-hp-bar">
          <div className={`token-hp-fill ${hpClass}`} style={{ width: `${hpPct}%` }} />
        </div>
      )}
      <div className={`token-shape ${typeClass}`} style={{ '--color': entity.color }}>
        <span>{initial}</span>
      </div>
      {entity.conditions.length > 0 && (
        <div className="token-conditions">
          {entity.conditions.slice(0, 4).map(c => (
            <div key={c} className="cond-dot" title={c}
              style={{ background: CONDITION_COLORS[c] || '#666' }}>
              {c[0]}
            </div>
          ))}
        </div>
      )}
      {showLabel && <div className="token-label">{entity.name}</div>}
    </div>
  );
}

// ====================================================================
// MAP CANVAS
// ====================================================================
function MapCanvas({
  map, entities, tokens, initiative, mode, peerId, claimedEntityId,
  onTokenMove, onTokenDoubleClick, onTokenContextMenu,
  onPlaceEntity, onViewportChange, selectedTokenId
}) {
  const wrapRef = useRef(null);
  const stageRef = useRef(null);
  const [viewport, setViewport] = useState(map?.viewport || { x: 0, y: 0, zoom: 1 });
  const [panning, setPanning] = useState(false);
  const panRef = useRef(null);
  const dragTokenRef = useRef(null);
  const [, forceRender] = useState(0);
  const [dragOver, setDragOver] = useState(false);

  // Update viewport when map changes
  useEffect(() => {
    setViewport(map?.viewport || { x: 0, y: 0, zoom: 1 });
  }, [map?.id]);

  // persist viewport debounced
  useEffect(() => {
    const handle = setTimeout(() => {
      if (mode === 'dm' && map) {
        onViewportChange?.(map.id, viewport);
      }
    }, 500);
    return () => clearTimeout(handle);
  }, [viewport.x, viewport.y, viewport.zoom]);

  const screenToWorld = useCallback((sx, sy) => {
    const rect = wrapRef.current.getBoundingClientRect();
    return {
      x: (sx - rect.left - viewport.x) / viewport.zoom,
      y: (sy - rect.top - viewport.y) / viewport.zoom,
    };
  }, [viewport]);

  // --- Panning ---
  const onWrapPointerDown = (e) => {
    if (e.target !== wrapRef.current && !e.target.classList.contains('canvas-stage') && !e.target.classList.contains('map-image')) return;
    setPanning(true);
    panRef.current = { startX: e.clientX, startY: e.clientY, vx: viewport.x, vy: viewport.y };
  };
  useEffect(() => {
    if (!panning) return;
    const onMove = (e) => {
      const dx = e.clientX - panRef.current.startX;
      const dy = e.clientY - panRef.current.startY;
      setViewport(v => ({ ...v, x: panRef.current.vx + dx, y: panRef.current.vy + dy }));
    };
    const onUp = () => setPanning(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [panning]);

  // --- Wheel zoom ---
  const onWheel = (e) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.0015;
    const nextZoom = clamp(viewport.zoom * (1 + delta), 0.15, 4);
    const rect = wrapRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // keep mouse position stable
    const ratio = nextZoom / viewport.zoom;
    const nx = mx - (mx - viewport.x) * ratio;
    const ny = my - (my - viewport.y) * ratio;
    setViewport({ x: nx, y: ny, zoom: nextZoom });
  };
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [viewport]);

  // --- Token dragging ---
  const startTokenDrag = (tokenId, e) => {
    const token = tokens[tokenId];
    if (!token) return;
    const point = e.touches ? e.touches[0] : e;
    const world = screenToWorld(point.clientX, point.clientY);
    dragTokenRef.current = {
      tokenId,
      offsetX: world.x - token.x,
      offsetY: world.y - token.y,
      lastX: token.x, lastY: token.y,
    };
    forceRender(n => n + 1);
  };
  useEffect(() => {
    const onMove = (e) => {
      if (!dragTokenRef.current) return;
      const point = e.touches ? e.touches[0] : e;
      const world = screenToWorld(point.clientX, point.clientY);
      const x = world.x - dragTokenRef.current.offsetX;
      const y = world.y - dragTokenRef.current.offsetY;
      dragTokenRef.current.lastX = x;
      dragTokenRef.current.lastY = y;
      forceRender(n => n + 1);
      // Also update DOM directly for smoothness
      const tokenEl = document.querySelector(`[data-tok="${dragTokenRef.current.tokenId}"]`);
      if (tokenEl) {
        tokenEl.style.left = (x - 22) + 'px';
        tokenEl.style.top = (y - 22) + 'px';
      }
    };
    const onUp = () => {
      if (dragTokenRef.current) {
        const { tokenId, lastX, lastY } = dragTokenRef.current;
        onTokenMove?.(tokenId, lastX, lastY);
        dragTokenRef.current = null;
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
  }, [onTokenMove, screenToWorld]);

  // --- HTML5 drag & drop from sidebar ---
  const onDragOver = (e) => {
    if (mode !== 'dm') return;
    e.preventDefault();
    setDragOver(true);
  };
  const onDragLeave = () => setDragOver(false);
  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (mode !== 'dm') return;
    const entityId = e.dataTransfer.getData('text/entity-id');
    if (!entityId) return;
    const world = screenToWorld(e.clientX, e.clientY);
    onPlaceEntity?.(entityId, world.x, world.y);
  };

  const zoomBy = (factor) => {
    const rect = wrapRef.current.getBoundingClientRect();
    const mx = rect.width / 2, my = rect.height / 2;
    const nextZoom = clamp(viewport.zoom * factor, 0.15, 4);
    const ratio = nextZoom / viewport.zoom;
    const nx = mx - (mx - viewport.x) * ratio;
    const ny = my - (my - viewport.y) * ratio;
    setViewport({ x: nx, y: ny, zoom: nextZoom });
  };
  const resetView = () => setViewport({ x: 0, y: 0, zoom: 1 });

  const canDragToken = (t) => {
    if (mode === 'dm') return true;
    const ent = entities[t.entityId];
    return ent && claimedEntityId === ent.id;
  };

  const currentInitEntityId = initiative.active && initiative.entries[initiative.turn]?.entityId;

  // --- Tokens visible on this map ---
  const visibleTokens = useMemo(
    () => Object.values(tokens).filter(t => t.mapId === map?.id),
    [tokens, map?.id]
  );

  return (
    <div
      ref={wrapRef}
      className={`canvas-wrap ${panning ? 'panning' : ''} ${dragOver ? 'can-drop' : ''}`}
      onPointerDown={onWrapPointerDown}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{ height: '100%', width: '100%' }}
    >
      <div
        ref={stageRef}
        className="canvas-stage"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
        }}
      >
        {map?.imageUrl ? (
          <img src={map.imageUrl} alt={map.name} className="map-image" draggable="false" />
        ) : null}

        {visibleTokens.map(t => {
          const ent = entities[t.entityId];
          if (!ent) return null;
          return (
            <TokenView
              key={t.id}
              token={t}
              entity={ent}
              isCurrent={currentInitEntityId === ent.id}
              isSelected={selectedTokenId === t.id}
              canDrag={canDragToken(t)}
              showLabel={mode === 'dm' || t.visible || claimedEntityId === ent.id}
              onStartDrag={(e) => startTokenDrag(t.id, e)}
              onDoubleClick={() => onTokenDoubleClick?.(t.id)}
              onContextMenu={mode === 'dm' ? (e) => onTokenContextMenu?.(t.id, e) : undefined}
            />
          );
        })}
      </div>

      {!map?.imageUrl && (
        <div className="map-empty">
          <div className="glyph">⚜</div>
          <div style={{ fontFamily: 'Cormorant Garamond, serif', fontStyle: 'italic', fontSize: 18 }}>
            {mode === 'dm'
              ? 'The canvas awaits. Upload a map image to begin.'
              : 'The realm is shrouded in mist.'}
          </div>
        </div>
      )}

      <div className="canvas-overlay top-right">
        <div className="zoom-controls">
          <button className="zoom-btn" title="Zoom in" onClick={() => zoomBy(1.2)}>＋</button>
          <button className="zoom-btn" title="Reset" onClick={resetView}>⌂</button>
          <button className="zoom-btn" title="Zoom out" onClick={() => zoomBy(1 / 1.2)}>－</button>
        </div>
      </div>
    </div>
  );
}

// ====================================================================
// ENTITY FORM (create / edit entity)
// ====================================================================
function EntityForm({ initial, onSave, onCancel }) {
  const [entity, setEntity] = useState(() => initial || makeEntity());

  const update = (patch) => setEntity(e => ({ ...e, ...patch }));
  const updateStat = (stat, value) => setEntity(e => ({ ...e, stats: { ...e.stats, [stat]: Number(value) || 0 } }));
  const updateHp = (key, value) => setEntity(e => ({ ...e, hp: { ...e.hp, [key]: Number(value) || 0 } }));

  useEffect(() => {
    // if type changes, reset color if default
    if (Object.values(DEFAULT_COLORS).includes(entity.color)) {
      setEntity(e => ({ ...e, color: DEFAULT_COLORS[e.type] }));
    }
  }, [entity.type]);

  return (
    <div className="form-grid">
      <div className="form-row-2">
        <div>
          <label>Name</label>
          <input value={entity.name} onChange={e => update({ name: e.target.value })} />
        </div>
        <div>
          <label>Type</label>
          <select value={entity.type} onChange={e => update({ type: e.target.value })}>
            {ENTITY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>

      <div className="form-row-3">
        <div>
          <label>Color</label>
          <input type="color" value={entity.color} onChange={e => update({ color: e.target.value })} />
        </div>
        <div>
          <label>AC</label>
          <input type="number" value={entity.ac} onChange={e => update({ ac: Number(e.target.value) || 0 })} />
        </div>
        <div>
          <label>Speed</label>
          <input type="number" value={entity.speed} onChange={e => update({ speed: Number(e.target.value) || 0 })} />
        </div>
      </div>

      <div className="form-row-3">
        <div>
          <label>HP Current</label>
          <input type="number" value={entity.hp.current} onChange={e => updateHp('current', e.target.value)} />
        </div>
        <div>
          <label>HP Max</label>
          <input type="number" value={entity.hp.max} onChange={e => updateHp('max', e.target.value)} />
        </div>
        <div>
          <label>Init Bonus</label>
          <input type="number" value={entity.initBonus} onChange={e => update({ initBonus: Number(e.target.value) || 0 })} />
        </div>
      </div>

      <div>
        <label>Ability Scores</label>
        <div className="form-row-6">
          {['str','dex','con','int','wis','cha'].map(s => (
            <div key={s} className="stat-box">
              <label>{s.toUpperCase()}</label>
              <input type="number" value={entity.stats[s]} onChange={e => updateStat(s, e.target.value)} />
              <div style={{ fontSize: 9, color: 'var(--ink-mute)', fontFamily: 'JetBrains Mono, monospace' }}>
                {modFor(entity.stats[s]) >= 0 ? `+${modFor(entity.stats[s])}` : modFor(entity.stats[s])}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="form-row-2">
        <div>
          <label>Passive Perception</label>
          <input type="number" value={entity.passivePerception} onChange={e => update({ passivePerception: Number(e.target.value) || 0 })} />
        </div>
        {entity.type === 'PC' && (
          <div>
            <label>Level</label>
            <input type="number" value={entity.level} onChange={e => update({ level: Number(e.target.value) || 1 })} />
          </div>
        )}
        {entity.type === 'Monster' && (
          <div>
            <label>Challenge Rating</label>
            <input value={entity.cr} onChange={e => update({ cr: e.target.value })} />
          </div>
        )}
        {entity.type === 'NPC' && (
          <div>
            <label>Faction</label>
            <input value={entity.faction} onChange={e => update({ faction: e.target.value })} />
          </div>
        )}
      </div>

      {entity.type === 'PC' && (
        <div className="form-row-2">
          <div>
            <label>Class</label>
            <input value={entity.class} onChange={e => update({ class: e.target.value })} placeholder="e.g. Wizard" />
          </div>
          <div>
            <label>Player Name</label>
            <input value={entity.playerName} onChange={e => update({ playerName: e.target.value })} />
          </div>
        </div>
      )}
      {entity.type === 'Monster' && (
        <div>
          <label>Abilities / Notes</label>
          <textarea value={entity.abilities} onChange={e => update({ abilities: e.target.value })}
            placeholder="Multiattack, breath weapon, legendary actions…" />
        </div>
      )}
      {entity.type === 'NPC' && (
        <div>
          <label>Role</label>
          <input value={entity.role} onChange={e => update({ role: e.target.value })} placeholder="Tavernkeeper, merchant…" />
        </div>
      )}

      <div>
        <label>Conditions</label>
        <div className="cond-grid">
          {CONDITIONS.map(c => (
            <div
              key={c}
              className={`cond-chip ${entity.conditions.includes(c) ? 'active' : ''}`}
              onClick={() => update({
                conditions: entity.conditions.includes(c)
                  ? entity.conditions.filter(x => x !== c)
                  : [...entity.conditions, c]
              })}
            >{c}</div>
          ))}
        </div>
      </div>

      <div>
        <label>Notes</label>
        <textarea value={entity.notes} onChange={e => update({ notes: e.target.value })} />
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" onClick={() => onSave(entity)}>Save</button>
      </div>
    </div>
  );
}

// ====================================================================
// ENTITY SIDEBAR (DM)
// ====================================================================
function EntitySidebar({ state, dispatch, onEditEntity, onSelectEntity, selectedEntityId }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('All');
  const [showDead, setShowDead] = useState(true);

  const entities = Object.values(state.entities);
  const filtered = entities.filter(e => {
    if (filter !== 'All' && e.type !== filter) return false;
    if (!showDead && e.hp.current <= 0) return false;
    if (search && !e.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name));

  const newEntity = () => onEditEntity(makeEntity());

  const adjustHp = (id, delta) => dispatch({ type: 'ENTITY_HP_ADJUST', id, delta });

  const tokensByEntity = useMemo(() => {
    const m = {};
    Object.values(state.tokens).forEach(t => {
      if (t.mapId === state.currentMapId) m[t.entityId] = t;
    });
    return m;
  }, [state.tokens, state.currentMapId]);

  return (
    <>
      <div className="sidebar-section">
        <div className="sidebar-title">
          <span>Bestiary</span>
          <button className="btn sm primary" onClick={newEntity}>＋ New</button>
        </div>
        <div className="search-row">
          <input placeholder="Search by name…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="filter-pills">
          {['All','PC','Monster','NPC'].map(f => (
            <div key={f} className={`pill ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>{f}</div>
          ))}
          <div className={`pill ${!showDead ? 'active' : ''}`} onClick={() => setShowDead(!showDead)}>
            {showDead ? 'Hide dead' : 'Show dead'}
          </div>
        </div>
      </div>
      <div className="sidebar-section grow">
        <div className="entity-list">
          {filtered.length === 0 && (
            <div className="empty-state">
              <span className="glyph">✦</span>
              {entities.length === 0 ? 'No entities yet. Forge one.' : 'No matching entities.'}
            </div>
          )}
          {filtered.map(e => {
            const onMap = tokensByEntity[e.id];
            const hpPct = e.hp.max > 0 ? e.hp.current / e.hp.max : 0;
            const hpClass = hpPct <= 0.25 ? 'critical' : hpPct <= 0.5 ? 'low' : '';
            const isDead = e.hp.current <= 0;
            const swatchClass = e.type === 'Monster' ? 'monster' : e.type === 'NPC' ? 'npc' : '';
            return (
              <div
                key={e.id}
                className={`entity-card ${selectedEntityId === e.id ? 'selected' : ''} ${isDead ? 'dead' : ''}`}
                draggable
                onDragStart={(ev) => {
                  ev.dataTransfer.setData('text/entity-id', e.id);
                  ev.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => onSelectEntity(e.id)}
              >
                <div className={`entity-swatch ${swatchClass}`} style={{ background: e.color }} />
                <div className="entity-info">
                  <div className="entity-name">{e.name}</div>
                  <div className="entity-meta">
                    <span className="mono">{e.type === 'PC' ? `L${e.level} ${e.class||''}` : e.type === 'Monster' ? `CR ${e.cr}` : e.role || 'NPC'}</span>
                    <span className={`entity-hp ${hpClass} mono`}>{e.hp.current}/{e.hp.max}</span>
                    <span className="mono" style={{ color: 'var(--ink-mute)' }}>AC {e.ac}</span>
                  </div>
                </div>
                {onMap && <div className={`vis-dot ${onMap.visible ? 'visible' : ''}`} title={onMap.visible ? 'Visible to players' : 'Hidden'} />}
                <div className="entity-actions" onClick={ev => ev.stopPropagation()}>
                  <button className="btn sm danger" onClick={() => adjustHp(e.id, -1)} title="-1 HP">−</button>
                  <button className="btn sm" onClick={() => adjustHp(e.id, +1)} title="+1 HP">+</button>
                  <button className="btn sm" onClick={() => onEditEntity(e)} title="Edit">✎</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ====================================================================
// INITIATIVE TRACKER
// ====================================================================
function InitiativeTracker({ state, dispatch, mode, onClose }) {
  const { initiative, entities, currentMapId } = state;
  const rollAll = () => {
    const tokensHere = Object.values(state.tokens).filter(t => t.mapId === currentMapId);
    const entitiesHere = tokensHere.map(t => entities[t.entityId]).filter(Boolean);
    const entries = entitiesHere.map(e => ({
      entityId: e.id,
      roll: roll(20) + (e.initBonus || 0),
    }));
    entries.sort((a, b) => b.roll - a.roll || (entities[b.entityId]?.initBonus || 0) - (entities[a.entityId]?.initBonus || 0) || entities[a.entityId].name.localeCompare(entities[b.entityId].name));
    dispatch({ type: 'INIT_SET', initiative: { active: true, entries, turn: 0, round: 1 } });
  };

  const clearInit = () => dispatch({ type: 'INIT_SET', initiative: { active: false, entries: [], turn: 0, round: 1 } });
  const advance = () => dispatch({ type: 'INIT_ADVANCE' });

  const updateRoll = (entityId, newRoll) => {
    const entries = initiative.entries.map(e => e.entityId === entityId ? { ...e, roll: Number(newRoll) || 0 } : e);
    entries.sort((a, b) => b.roll - a.roll);
    dispatch({ type: 'INIT_SET', initiative: { ...initiative, entries } });
  };

  const removeEntry = (entityId) => {
    const entries = initiative.entries.filter(e => e.entityId !== entityId);
    const turn = Math.min(initiative.turn, Math.max(0, entries.length - 1));
    dispatch({ type: 'INIT_SET', initiative: { ...initiative, entries, turn } });
  };

  return (
    <div className="float-panel" style={{ right: 16, top: 80, width: 340 }}>
      <div className="float-panel-header">
        <span>⚔ Initiative · Round {initiative.round}</span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">
        {mode === 'dm' && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            <button className="btn primary" onClick={rollAll}>🎲 Roll All</button>
            <button className="btn" onClick={advance} disabled={!initiative.entries.length}>⏭ Next Turn</button>
            <button className="btn danger" onClick={clearInit} disabled={!initiative.entries.length}>Clear</button>
          </div>
        )}
        <div className="init-list">
          {initiative.entries.length === 0 ? (
            <div className="empty-state"><span className="glyph">⚔</span>Initiative not yet rolled.</div>
          ) : initiative.entries.map((entry, idx) => {
            const e = entities[entry.entityId];
            if (!e) return null;
            return (
              <div key={entry.entityId} className={`init-entry ${idx === initiative.turn ? 'current' : ''}`}>
                {mode === 'dm' ? (
                  <input className="mono" type="number" value={entry.roll}
                    onChange={(ev) => updateRoll(entry.entityId, ev.target.value)}
                    style={{ width: 48, padding: 4, textAlign: 'center', fontWeight: 600 }} />
                ) : (
                  <div className="init-roll">{entry.roll}</div>
                )}
                <div className="entity-swatch" style={{ background: e.color, width: 10, height: 10 }} />
                <div className="init-name">{e.name}</div>
                <div className="init-hp">{e.hp.current}/{e.hp.max}</div>
                {mode === 'dm' && (
                  <button className="btn sm ghost" onClick={() => removeEntry(entry.entityId)} title="Remove">×</button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ====================================================================
// MAP MANAGER
// ====================================================================
function MapManager({ state, dispatch, onClose, toast }) {
  const [editing, setEditing] = useState(null);
  const maps = Object.values(state.maps);

  const newMap = () => {
    const id = uid('map_');
    setEditing({ id, name: 'New Map', type: 'region', parentId: null, imageUrl: null, notes: '', viewport: { x: 0, y: 0, zoom: 1 } });
  };

  const uploadImage = async () => {
    const data = await pickImage();
    if (data) setEditing({ ...editing, imageUrl: data });
  };

  const saveMap = () => {
    dispatch({ type: 'MAP_UPSERT', map: editing });
    setEditing(null);
    toast('Map saved', 'success');
  };

  const deleteMap = (id) => {
    if (!confirm('Delete this map and all its tokens?')) return;
    dispatch({ type: 'MAP_DELETE', id });
    toast('Map deleted');
  };

  if (editing) {
    return (
      <div className="float-panel" style={{ right: 16, top: 80, width: 400 }}>
        <div className="float-panel-header">
          <span>⌖ {state.maps[editing.id] ? 'Edit Map' : 'New Map'}</span>
          <button className="close-x" onClick={() => setEditing(null)}>×</button>
        </div>
        <div className="float-panel-body">
          <div className="form-grid">
            <div>
              <label>Name</label>
              <input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} />
            </div>
            <div className="form-row-2">
              <div>
                <label>Type</label>
                <select value={editing.type} onChange={e => setEditing({ ...editing, type: e.target.value })}>
                  <option value="world">World</option>
                  <option value="region">Region</option>
                  <option value="city">City</option>
                  <option value="dungeon">Dungeon</option>
                  <option value="interior">Interior</option>
                  <option value="encounter">Encounter</option>
                </select>
              </div>
              <div>
                <label>Parent Map</label>
                <select value={editing.parentId || ''} onChange={e => setEditing({ ...editing, parentId: e.target.value || null })}>
                  <option value="">— None —</option>
                  {maps.filter(m => m.id !== editing.id).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label>Map Image</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn" onClick={uploadImage}>📁 Upload Image</button>
                {editing.imageUrl && (
                  <>
                    <img src={editing.imageUrl} style={{ height: 48, borderRadius: 4, border: '1px solid var(--border)' }} />
                    <button className="btn sm danger" onClick={() => setEditing({ ...editing, imageUrl: null })}>Clear</button>
                  </>
                )}
              </div>
              <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginTop: 4 }}>Embedded as base64 — stays in session.</div>
            </div>
            <div>
              <label>Notes (DM only)</label>
              <textarea value={editing.notes} onChange={e => setEditing({ ...editing, notes: e.target.value })} />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn primary" onClick={saveMap}>Save Map</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="float-panel" style={{ right: 16, top: 80, width: 360 }}>
      <div className="float-panel-header">
        <span>⌖ Maps & Realms</span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">
        <button className="btn primary" onClick={newMap} style={{ marginBottom: 12 }}>＋ New Map</button>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {maps.map(m => {
            const parent = m.parentId ? state.maps[m.parentId]?.name : null;
            const isCurrent = state.currentMapId === m.id;
            return (
              <div key={m.id} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: 10, borderRadius: 5,
                background: isCurrent ? 'rgba(212,165,116,0.1)' : 'var(--bg-0)',
                border: `1px solid ${isCurrent ? 'var(--gold-dim)' : 'var(--border-soft)'}`
              }}>
                {m.imageUrl && <img src={m.imageUrl} style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 3 }} />}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{m.name}</div>
                  <div style={{ fontSize: 10, color: 'var(--ink-mute)' }}>
                    {m.type}{parent ? ` · in ${parent}` : ''}
                  </div>
                </div>
                <button className="btn sm" onClick={() => dispatch({ type: 'MAP_SWITCH', id: m.id })} disabled={isCurrent}>Go</button>
                <button className="btn sm ghost" onClick={() => setEditing(deepClone(m))}>✎</button>
                <button className="btn sm ghost" onClick={() => deleteMap(m.id)} disabled={maps.length <= 1}>×</button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ====================================================================
// PRESETS PANEL
// ====================================================================
function PresetsPanel({ state, dispatch, onClose, toast }) {
  const [name, setName] = useState('');
  const presets = Object.values(state.presets);

  const savePreset = () => {
    if (!name.trim()) { toast('Enter a name', 'error'); return; }
    const tokensOnMap = Object.values(state.tokens).filter(t => t.mapId === state.currentMapId);
    const preset = {
      id: uid('preset_'),
      name: name.trim(),
      mapId: state.currentMapId,
      tokens: tokensOnMap.map(t => ({ ...t })),
    };
    dispatch({ type: 'PRESET_SAVE', preset });
    setName('');
    toast('Preset saved', 'success');
  };

  const loadPreset = (preset) => {
    if (!confirm(`Load "${preset.name}"? This replaces tokens on the target map.`)) return;
    // Remove current tokens on that map and restore preset tokens
    Object.keys(state.tokens).forEach(tid => {
      if (state.tokens[tid].mapId === preset.mapId) {
        dispatch({ type: 'TOKEN_REMOVE', id: tid });
      }
    });
    preset.tokens.forEach(t => {
      dispatch({ type: 'TOKEN_PLACE', token: { ...t, id: uid('tok_') } });
    });
    dispatch({ type: 'MAP_SWITCH', id: preset.mapId });
    toast('Preset loaded', 'success');
  };

  const overwritePreset = (preset) => {
    if (!confirm(`Overwrite "${preset.name}" with current state?`)) return;
    const tokensOnMap = Object.values(state.tokens).filter(t => t.mapId === state.currentMapId);
    dispatch({
      type: 'PRESET_SAVE',
      preset: { ...preset, mapId: state.currentMapId, tokens: tokensOnMap.map(t => ({ ...t })) }
    });
    toast('Preset overwritten', 'success');
  };

  const deletePreset = (id) => {
    if (!confirm('Delete this preset?')) return;
    dispatch({ type: 'PRESET_DELETE', id });
  };

  return (
    <div className="float-panel" style={{ right: 16, top: 80, width: 360 }}>
      <div className="float-panel-header">
        <span>❈ Encounter Presets</span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          <input placeholder="Name this encounter…" value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && savePreset()} />
          <button className="btn primary" onClick={savePreset}>Save</button>
        </div>
        {presets.length === 0 ? (
          <div className="empty-state"><span className="glyph">❈</span>No saved encounters yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {presets.map(p => {
              const map = state.maps[p.mapId];
              return (
                <div key={p.id} style={{
                  padding: 10, borderRadius: 5,
                  background: 'var(--bg-0)', border: '1px solid var(--border-soft)'
                }}>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{p.name}</div>
                  <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginBottom: 6 }}>
                    {p.tokens.length} tokens · {map?.name || 'unknown map'}
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn sm primary" onClick={() => loadPreset(p)}>Load</button>
                    <button className="btn sm" onClick={() => overwritePreset(p)}>Overwrite</button>
                    <button className="btn sm danger" onClick={() => deletePreset(p.id)}>×</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ====================================================================
// TOKEN DETAIL PANEL
// ====================================================================
function TokenDetailPanel({ token, entity, mode, dispatch, onClose, canEditEntity, claimedEntityId }) {
  const [hpDelta, setHpDelta] = useState(0);

  if (!entity) return null;

  const isDM = mode === 'dm';
  const isOwnPC = entity.id === claimedEntityId;
  const canEdit = isDM;

  const applyHp = (sign) => {
    const d = Math.abs(hpDelta) * sign;
    dispatch({ type: 'ENTITY_HP_ADJUST', id: entity.id, delta: d });
    setHpDelta(0);
  };

  const toggleCondition = (c) => dispatch({ type: 'ENTITY_TOGGLE_CONDITION', id: entity.id, condition: c });

  const toggleVisibility = () => {
    dispatch({ type: 'TOKEN_VISIBILITY', id: token.id, visible: !token.visible });
  };

  const removeToken = () => {
    if (!confirm('Remove this token from the map?')) return;
    dispatch({ type: 'TOKEN_REMOVE', id: token.id });
    onClose();
  };

  return (
    <div className="float-panel" style={{ left: 16, top: 80, width: 340 }}>
      <div className="float-panel-header">
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="entity-swatch" style={{ background: entity.color, width: 12, height: 12 }} />
          {entity.name}
        </span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
          <div style={{ textAlign: 'center', padding: 8, background: 'var(--bg-0)', borderRadius: 4, border: '1px solid var(--border-soft)' }}>
            <div style={{ fontSize: 10, color: 'var(--ink-dim)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>AC</div>
            <div className="mono" style={{ fontSize: 20, fontWeight: 600, color: 'var(--gold)' }}>{entity.ac}</div>
          </div>
          <div style={{ textAlign: 'center', padding: 8, background: 'var(--bg-0)', borderRadius: 4, border: '1px solid var(--border-soft)' }}>
            <div style={{ fontSize: 10, color: 'var(--ink-dim)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>HP</div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{entity.hp.current}<span style={{ color: 'var(--ink-mute)', fontSize: 12 }}>/{entity.hp.max}</span></div>
          </div>
          <div style={{ textAlign: 'center', padding: 8, background: 'var(--bg-0)', borderRadius: 4, border: '1px solid var(--border-soft)' }}>
            <div style={{ fontSize: 10, color: 'var(--ink-dim)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Speed</div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{entity.speed}</div>
          </div>
        </div>

        <div style={{ fontSize: 11, color: 'var(--ink-dim)', marginBottom: 8 }}>
          {entity.type === 'PC' && `Level ${entity.level} ${entity.class || ''}${entity.playerName ? ` · ${entity.playerName}` : ''}`}
          {entity.type === 'Monster' && `CR ${entity.cr}`}
          {entity.type === 'NPC' && (entity.faction ? `${entity.role} · ${entity.faction}` : entity.role || 'NPC')}
        </div>

        {canEdit && (
          <>
            <label>Adjust HP</label>
            <div className="hp-adjuster" style={{ marginBottom: 10 }}>
              <button className="btn danger" onClick={() => applyHp(-1)}>− Damage</button>
              <input type="number" value={hpDelta} onChange={e => setHpDelta(Math.abs(Number(e.target.value)) || 0)} />
              <button className="btn" onClick={() => applyHp(+1)}>+ Heal</button>
            </div>
          </>
        )}

        <div style={{ marginBottom: 10 }}>
          <label>Conditions</label>
          <div className="cond-grid">
            {CONDITIONS.slice(0, 15).map(c => (
              <div
                key={c}
                className={`cond-chip ${entity.conditions.includes(c) ? 'active' : ''}`}
                onClick={canEdit || isOwnPC ? () => toggleCondition(c) : undefined}
                style={{ cursor: (canEdit || isOwnPC) ? 'pointer' : 'default' }}
              >{c}</div>
            ))}
          </div>
        </div>

        {isDM && entity.type === 'Monster' && entity.abilities && (
          <div style={{ marginBottom: 10 }}>
            <label>Abilities</label>
            <div style={{ fontSize: 12, padding: 8, background: 'var(--bg-0)', borderRadius: 4, whiteSpace: 'pre-wrap' }}>{entity.abilities}</div>
          </div>
        )}

        {(isDM || isOwnPC) && entity.notes && (
          <div style={{ marginBottom: 10 }}>
            <label>Notes</label>
            <div style={{ fontSize: 12, padding: 8, background: 'var(--bg-0)', borderRadius: 4, whiteSpace: 'pre-wrap' }}>{entity.notes}</div>
          </div>
        )}

        {isDM && (
          <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
            <button className="btn" onClick={toggleVisibility}>
              {token.visible ? '👁 Hide from players' : '👁 Reveal to players'}
            </button>
            <button className="btn danger" onClick={removeToken}>Remove</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ====================================================================
// BREADCRUMB
// ====================================================================
function Breadcrumb({ map, maps, onSwitch }) {
  const chain = [];
  let c = map;
  while (c) {
    chain.unshift(c);
    c = c.parentId ? maps[c.parentId] : null;
  }
  return (
    <div className="breadcrumb">
      {chain.map((m, i) => (
        <React.Fragment key={m.id}>
          {i > 0 && <span className="breadcrumb-sep">›</span>}
          <span
            className={`breadcrumb-item ${i === chain.length - 1 ? 'current' : ''}`}
            onClick={i === chain.length - 1 ? undefined : () => onSwitch(m.id)}
          >{m.name}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

// ====================================================================
// DM INTERFACE
// ====================================================================
function DMInterface({ state, dispatch, sync, syncStatus, peerCount, onLogout, roomCode, toast }) {
  const [editingEntity, setEditingEntity] = useState(null);
  const [selectedEntityId, setSelectedEntityId] = useState(null);
  const [selectedTokenId, setSelectedTokenId] = useState(null);
  const [showInit, setShowInit] = useState(false);
  const [showMaps, setShowMaps] = useState(false);
  const [showPresets, setShowPresets] = useState(false);

  const currentMap = state.maps[state.currentMapId];
  const selectedToken = selectedTokenId ? state.tokens[selectedTokenId] : null;
  const selectedTokenEntity = selectedToken ? state.entities[selectedToken.entityId] : null;

  const placeEntity = (entityId, x, y) => {
    const existing = Object.values(state.tokens).find(t => t.entityId === entityId && t.mapId === state.currentMapId);
    if (existing) {
      toast('Entity already placed on this map', 'error');
      return;
    }
    dispatch({
      type: 'TOKEN_PLACE',
      token: {
        id: uid('tok_'),
        entityId,
        mapId: state.currentMapId,
        x, y,
        visible: false, // new tokens default hidden
      }
    });
    toast('Token placed (hidden)', 'success');
  };

  const tokenMove = (tokenId, x, y) => {
    dispatch({ type: 'TOKEN_MOVE', id: tokenId, x, y });
  };

  const tokenDoubleClick = (tokenId) => setSelectedTokenId(tokenId);
  const tokenContextMenu = (tokenId, e) => {
    if (confirm('Remove this token?')) dispatch({ type: 'TOKEN_REMOVE', id: tokenId });
  };

  const revealAllOnMap = (visible) => {
    dispatch({ type: 'TOKEN_REVEAL_ALL_ON_MAP', mapId: state.currentMapId, visible });
    toast(visible ? 'All tokens revealed' : 'All tokens hidden');
  };

  const saveEntity = (entity) => {
    dispatch({ type: 'ENTITY_UPSERT', entity });
    setEditingEntity(null);
    toast('Entity saved', 'success');
  };

  const deleteCurrentEntity = () => {
    if (!editingEntity || !state.entities[editingEntity.id]) { setEditingEntity(null); return; }
    if (!confirm('Delete this entity? All tokens will be removed.')) return;
    dispatch({ type: 'ENTITY_DELETE', id: editingEntity.id });
    setEditingEntity(null);
    toast('Entity deleted');
  };

  const onViewportChange = (mapId, viewport) => {
    dispatch({ type: 'MAP_VIEWPORT', id: mapId, viewport });
  };

  const pushView = () => {
    if (state.forcedView?.mapId === state.currentMapId) {
      dispatch({ type: 'FORCED_VIEW', forcedView: null });
      toast('Released player view control');
    } else {
      dispatch({ type: 'FORCED_VIEW', forcedView: { mapId: state.currentMapId } });
      toast('Players locked to this map', 'success');
    }
  };

  const exportSession = () => {
    downloadJson(state, `shadowquill-session-${Date.now()}.json`);
    toast('Session exported', 'success');
  };

  const importSession = async () => {
    const result = await pickFile();
    if (!result) return;
    try {
      const data = JSON.parse(result.content);
      if (!confirm('This replaces your current session. Continue?')) return;
      dispatch({ type: 'REPLACE', payload: data });
      toast('Session imported', 'success');
    } catch {
      toast('Invalid session file', 'error');
    }
  };

  return (
    <div className="app-shell">
      <div className="topbar">
        <span className="mode-badge dm">⚔ Dungeon Master</span>
        <span className="topbar-title">Shadowquill</span>
        <div className="topbar-divider" />
        <button className="btn" onClick={() => setShowMaps(true)}>⌖ Maps</button>
        <button className={`btn ${showInit ? 'active' : ''}`} onClick={() => setShowInit(!showInit)}>⚔ Initiative</button>
        <button className="btn" onClick={() => setShowPresets(true)}>❈ Presets</button>
        <div className="topbar-divider" />
        <button className="btn" onClick={() => revealAllOnMap(true)}>👁 Reveal All</button>
        <button className="btn" onClick={() => revealAllOnMap(false)}>🕶 Hide All</button>
        <button className={`btn ${state.forcedView?.mapId === state.currentMapId ? 'danger active' : ''}`} onClick={pushView}>
          {state.forcedView?.mapId === state.currentMapId ? '⚑ Release' : '⚑ Push View'}
        </button>
        <div className="topbar-spacer" />
        {roomCode && (
          <div className="conn-status">
            <div className={`conn-dot ${syncStatus === 'live' ? 'live' : syncStatus === 'connecting' ? 'connecting' : syncStatus === 'error' ? 'error' : ''}`} />
            <span className="mono">{roomCode}</span>
            <span style={{ color: 'var(--ink-dim)' }}>· {peerCount} {peerCount === 1 ? 'player' : 'players'}</span>
          </div>
        )}
        <button className="btn" onClick={exportSession}>⇩ Export</button>
        <button className="btn" onClick={importSession}>⇧ Import</button>
        <button className="btn ghost" onClick={onLogout}>⎋ Exit</button>
      </div>

      <div className="main">
        <div className="sidebar">
          <EntitySidebar
            state={state}
            dispatch={dispatch}
            onEditEntity={setEditingEntity}
            onSelectEntity={setSelectedEntityId}
            selectedEntityId={selectedEntityId}
          />
        </div>

        <MapCanvas
          map={currentMap}
          entities={state.entities}
          tokens={state.tokens}
          initiative={state.initiative}
          mode="dm"
          onTokenMove={tokenMove}
          onTokenDoubleClick={tokenDoubleClick}
          onTokenContextMenu={tokenContextMenu}
          onPlaceEntity={placeEntity}
          onViewportChange={onViewportChange}
          selectedTokenId={selectedTokenId}
        />

        <div className="canvas-overlay top-left">
          <Breadcrumb map={currentMap} maps={state.maps} onSwitch={(id) => dispatch({ type: 'MAP_SWITCH', id })} />
        </div>

        {showInit && <InitiativeTracker state={state} dispatch={dispatch} mode="dm" onClose={() => setShowInit(false)} />}
        {showMaps && <MapManager state={state} dispatch={dispatch} onClose={() => setShowMaps(false)} toast={toast} />}
        {showPresets && <PresetsPanel state={state} dispatch={dispatch} onClose={() => setShowPresets(false)} toast={toast} />}

        {selectedToken && selectedTokenEntity && (
          <TokenDetailPanel
            token={selectedToken}
            entity={selectedTokenEntity}
            mode="dm"
            dispatch={dispatch}
            onClose={() => setSelectedTokenId(null)}
          />
        )}

        {editingEntity && (
          <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setEditingEntity(null)}>
            <div className="modal slide-up">
              <div className="float-panel-header">
                <span>{state.entities[editingEntity.id] ? '✎ Edit Entity' : '＋ New Entity'}</span>
                <button className="close-x" onClick={() => setEditingEntity(null)}>×</button>
              </div>
              <div className="float-panel-body">
                <EntityForm
                  initial={editingEntity}
                  onSave={saveEntity}
                  onCancel={() => setEditingEntity(null)}
                />
                {state.entities[editingEntity.id] && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-soft)' }}>
                    <button className="btn danger" onClick={deleteCurrentEntity}>Delete Entity</button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ====================================================================
// PLAYER INTERFACE
// ====================================================================
function PlayerInterface({ state, myPeerId, playerName, sync, syncStatus, onLogout, roomCode, toast }) {
  const [selectedTokenId, setSelectedTokenId] = useState(null);
  const [showInit, setShowInit] = useState(false);
  const [showClaim, setShowClaim] = useState(false);

  const claimedEntityId = state.claimedPCs?.[myPeerId];
  const claimedEntity = claimedEntityId ? state.entities[claimedEntityId] : null;

  const currentMapId = state.forcedView?.mapId || state.playerMapOverride || state.currentMapId;
  const currentMap = state.maps[currentMapId];
  const isForced = !!state.forcedView;

  const selectedToken = selectedTokenId ? state.tokens[selectedTokenId] : null;
  const selectedTokenEntity = selectedToken ? state.entities[selectedToken.entityId] : null;

  const tokenMove = (tokenId, x, y) => {
    const token = state.tokens[tokenId];
    if (!token) return;
    const entity = state.entities[token.entityId];
    if (!entity || entity.id !== claimedEntityId) {
      toast('You may only move your own character', 'error');
      return;
    }
    // optimistic local update
    // send to DM
    sync.sendPlayerAction({
      type: 'move_token',
      payload: { tokenId, x, y },
      peerId: myPeerId,
    });
  };

  const tokenDoubleClick = (tokenId) => setSelectedTokenId(tokenId);

  const claimPC = (entityId) => {
    sync.sendPlayerAction({
      type: 'claim_pc',
      payload: { entityId },
      peerId: myPeerId,
    });
    setShowClaim(false);
    toast('Requesting character…', 'success');
  };

  const unclaimPC = () => {
    sync.sendPlayerAction({
      type: 'unclaim_pc',
      payload: {},
      peerId: myPeerId,
    });
  };

  const unclaimedPCs = Object.values(state.entities).filter(e => {
    if (e.type !== 'PC') return false;
    return !Object.values(state.claimedPCs || {}).includes(e.id);
  });

  return (
    <div className="app-shell">
      <div className="topbar">
        <span className="mode-badge player">⌂ Player</span>
        <span className="topbar-title">Shadowquill</span>
        <div className="topbar-divider" />
        {claimedEntity ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className="entity-swatch" style={{ background: claimedEntity.color, width: 12, height: 12 }} />
            <span style={{ fontSize: 13, fontWeight: 500 }}>{claimedEntity.name}</span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-dim)' }}>
              {claimedEntity.hp.current}/{claimedEntity.hp.max} HP
            </span>
            <button className="btn sm ghost" onClick={unclaimPC}>Release</button>
          </div>
        ) : (
          <button className="btn primary" onClick={() => setShowClaim(true)}>⚐ Claim Character</button>
        )}
        <div className="topbar-divider" />
        <button className={`btn ${showInit ? 'active' : ''}`} onClick={() => setShowInit(!showInit)}>⚔ Initiative</button>
        <div className="topbar-spacer" />
        <div className="conn-status">
          <div className={`conn-dot ${syncStatus === 'live' ? 'live' : syncStatus === 'connecting' ? 'connecting' : syncStatus === 'error' ? 'error' : ''}`} />
          <span className="mono">{roomCode}</span>
          <span style={{ color: 'var(--ink-dim)' }}>· {playerName}</span>
        </div>
        <button className="btn ghost" onClick={onLogout}>⎋ Leave</button>
      </div>

      <div className="main player-view">
        <MapCanvas
          map={currentMap}
          entities={state.entities}
          tokens={state.tokens}
          initiative={state.initiative}
          mode="player"
          peerId={myPeerId}
          claimedEntityId={claimedEntityId}
          onTokenMove={tokenMove}
          onTokenDoubleClick={tokenDoubleClick}
          onPlaceEntity={() => {}}
          onViewportChange={() => {}}
          selectedTokenId={selectedTokenId}
        />

        <div className="canvas-overlay top-left">
          {currentMap && <Breadcrumb map={currentMap} maps={state.maps} onSwitch={() => {}} />}
        </div>

        {isForced && (
          <div className="canvas-overlay bottom-center">
            <div className="forced-view-banner">
              <span className="glyph">⚑</span>
              DM-controlled view · {currentMap?.name}
            </div>
          </div>
        )}

        {syncStatus !== 'live' && (
          <div className="canvas-overlay bottom-center">
            <div className="forced-view-banner">
              {syncStatus === 'connecting' ? 'Connecting to the table…' : syncStatus === 'error' ? 'Connection lost. Reopen the page to retry.' : 'Offline'}
            </div>
          </div>
        )}

        {showInit && <InitiativeTracker state={state} dispatch={() => {}} mode="player" onClose={() => setShowInit(false)} />}

        {selectedToken && selectedTokenEntity && (
          <TokenDetailPanel
            token={selectedToken}
            entity={selectedTokenEntity}
            mode="player"
            dispatch={() => {}}
            onClose={() => setSelectedTokenId(null)}
            claimedEntityId={claimedEntityId}
          />
        )}

        {showClaim && (
          <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowClaim(false)}>
            <div className="modal slide-up" style={{ maxWidth: 440 }}>
              <div className="float-panel-header">
                <span>⚐ Claim a Character</span>
                <button className="close-x" onClick={() => setShowClaim(false)}>×</button>
              </div>
              <div className="float-panel-body">
                {unclaimedPCs.length === 0 ? (
                  <div className="empty-state"><span className="glyph">⚔</span>No unclaimed characters. Ask your DM to create one.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {unclaimedPCs.map(e => (
                      <div key={e.id}
                        style={{ padding: 12, background: 'var(--bg-0)', borderRadius: 6, border: '1px solid var(--border-soft)',
                          display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}
                        onClick={() => claimPC(e.id)}
                      >
                        <div className="pc-avatar" style={{ background: e.color, width: 36, height: 36 }}>
                          {e.name[0]?.toUpperCase()}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 500 }}>{e.name}</div>
                          <div style={{ fontSize: 11, color: 'var(--ink-dim)' }}>
                            Level {e.level} {e.class} · {e.hp.max} HP · AC {e.ac}
                          </div>
                        </div>
                        <button className="btn primary sm">Claim</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ====================================================================
// ROOT APP
// ====================================================================
function Root() {
  const [auth, setAuth] = useState(() => {
    try {
      const raw = localStorage.getItem(AUTH_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    return null;
  });

  if (!auth) {
    return (
      <AuthScreen onAuth={(a) => {
        setAuth(a);
        try { localStorage.setItem(AUTH_KEY, JSON.stringify(a)); } catch {}
      }} />
    );
  }

  const logout = () => {
    try { localStorage.removeItem(AUTH_KEY); } catch {}
    setAuth(null);
  };

  return <Session auth={auth} onLogout={logout} />;
}

function Session({ auth, onLogout }) {
  const toast = useToast();
  const [state, dispatch] = useReducer(reducer, null, () => {
    if (auth.mode === 'dm') {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw);
      } catch {}
      return makeDefaultState();
    }
    // Player starts with empty state (will be hydrated by DM)
    return makeDefaultState();
  });

  const [syncStatus, setSyncStatus] = useState('offline');
  const [peerList, setPeerList] = useState([]);
  const [myPeerId, setMyPeerId] = useState(null);
  const syncRef = useRef(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Persist DM state
  useEffect(() => {
    if (auth.mode === 'dm') {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
    }
  }, [state, auth.mode]);

  // Setup sync
  useEffect(() => {
    if (auth.local) return;
    if (!auth.roomCode) return;

    const sync = new SyncManager({
      mode: auth.mode,
      onStateUpdate: (newState) => {
        if (auth.mode === 'player') {
          dispatch({ type: 'REPLACE', payload: newState });
        }
      },
      onPlayerAction: (action, peerId) => {
        handlePlayerAction(action, peerId);
      },
      onStatusChange: setSyncStatus,
      onPeerListChange: setPeerList,
      onError: (msg) => toast(msg, 'error'),
    });

    syncRef.current = sync;

    if (auth.mode === 'dm') {
      sync.hostSession(auth.roomCode);
    } else {
      sync.joinSession(auth.roomCode);
    }

    const pollPeerId = setInterval(() => {
      if (sync.myPeerId && !myPeerId) {
        setMyPeerId(sync.myPeerId);
      }
    }, 200);

    return () => {
      clearInterval(pollPeerId);
      sync.destroy();
    };
  }, [auth.roomCode, auth.mode, auth.local]);

  // DM broadcasts on state change
  useEffect(() => {
    if (auth.mode !== 'dm' || !syncRef.current || syncStatus !== 'live') return;
    // Broadcast filtered state per player
    const handle = setTimeout(() => {
      peerList.forEach(pid => {
        const conn = syncRef.current.connections.get(pid);
        if (conn?.open) {
          try {
            conn.send({
              type: 'state_update',
              payload: filterStateForPlayer(stateRef.current, pid)
            });
          } catch {}
        }
      });
    }, 30);
    return () => clearTimeout(handle);
  }, [state, peerList, syncStatus, auth.mode]);

  // Send initial state to new peers
  useEffect(() => {
    if (auth.mode !== 'dm' || !syncRef.current) return;
    peerList.forEach(pid => {
      const conn = syncRef.current.connections.get(pid);
      if (conn?.open) {
        try {
          conn.send({ type: 'state_update', payload: filterStateForPlayer(stateRef.current, pid) });
        } catch {}
      }
    });
  }, [peerList, auth.mode]);

  // Handle player actions (DM side)
  const handlePlayerAction = useCallback((action, peerId) => {
    const curr = stateRef.current;
    switch (action.type) {
      case 'claim_pc': {
        const { entityId } = action.payload;
        const entity = curr.entities[entityId];
        if (!entity || entity.type !== 'PC') return;
        // already claimed?
        if (Object.entries(curr.claimedPCs || {}).some(([k, v]) => v === entityId && k !== peerId)) return;
        dispatch({ type: 'CLAIM_PC', peerId, entityId });
        toast(`${entity.name} claimed by a player`, 'success');
        break;
      }
      case 'unclaim_pc':
        dispatch({ type: 'UNCLAIM_PC', peerId });
        break;
      case 'move_token': {
        const { tokenId, x, y } = action.payload;
        const token = curr.tokens[tokenId];
        if (!token) return;
        const entity = curr.entities[token.entityId];
        if (!entity) return;
        // Check ownership
        if (curr.claimedPCs?.[peerId] !== entity.id) return;
        dispatch({ type: 'TOKEN_MOVE', id: tokenId, x, y });
        break;
      }
    }
  }, [toast]);

  if (auth.mode === 'dm') {
    return (
      <DMInterface
        state={state}
        dispatch={dispatch}
        sync={syncRef.current}
        syncStatus={auth.local ? 'local' : syncStatus}
        peerCount={peerList.length}
        onLogout={onLogout}
        roomCode={auth.local ? null : auth.roomCode}
        toast={toast}
      />
    );
  }

  return (
    <PlayerInterface
      state={state}
      myPeerId={myPeerId}
      playerName={auth.playerName}
      sync={syncRef.current}
      syncStatus={syncStatus}
      onLogout={onLogout}
      roomCode={auth.roomCode}
      toast={toast}
    />
  );
}

// ====================================================================
// MOUNT
// ====================================================================
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <ToastProvider>
    <Root />
  </ToastProvider>
);

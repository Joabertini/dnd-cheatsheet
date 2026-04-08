/**
 * Bertini Sync — Foundry VTT Module
 * Conecta la character sheet del jugador con la Bertini Cheat Sheet web.
 *
 * Flujo:
 *  1. El jugador abre su character sheet y hace click en el botón 📱
 *  2. El módulo llama a /__sync/generate con el actorId del personaje
 *  3. El Worker devuelve un código tipo "LOBO4821"
 *  4. El jugador ingresa ese código en la web
 *  5. Desde ese momento, cada cambio en HP/condiciones/recursos se pushea
 */

const SYNC_URL = 'https://dnd-cheatsheet-proxy.bertinisdnd.workers.dev';
const PUSH_INTERVAL_MS = 2000; // push cada 2s si hubo cambios

// ── Estado global del módulo ──────────────────────────────────────────────────
const state = {
  roomIds: {},    // actorId → roomId (persistido en flags del actor)
  timers: {},     // actorId → intervalId
  lastPush: {},   // actorId → JSON del último estado pusheado
};

// ── Init ──────────────────────────────────────────────────────────────────────
Hooks.once('ready', () => {
  console.log('Bertini Sync | Módulo listo');

  // Restaurar salas de sesiones previas
  for (const actor of game.actors) {
    if (!actor.isOwner) continue;
    const roomId = actor.getFlag('bertini-sync', 'roomId');
    if (roomId) {
      state.roomIds[actor.id] = roomId;
      startPushing(actor);
      console.log(`Bertini Sync | Reconectado: ${actor.name} → ${roomId}`);
    }
  }
});

// ── Botón en el header del character sheet ────────────────────────────────────
Hooks.on('getActorSheetHeaderButtons', (sheet, buttons) => {
  const actor = sheet.actor;
  if (!actor.isOwner || actor.type !== 'character') return;

  buttons.unshift({
    label: '',
    icon: 'fas fa-mobile-screen',
    class: 'bertini-sync-btn',
    onclick: () => openSyncDialog(actor),
  });
});

// ── Escuchar cambios en el actor ──────────────────────────────────────────────
Hooks.on('updateActor', (actor) => {
  if (state.roomIds[actor.id]) schedulePush(actor);
});

Hooks.on('createActiveEffect', (effect) => {
  const actor = effect.parent;
  if (actor && state.roomIds[actor.id]) schedulePush(actor);
});

Hooks.on('deleteActiveEffect', (effect) => {
  const actor = effect.parent;
  if (actor && state.roomIds[actor.id]) schedulePush(actor);
});

Hooks.on('updateItem', (item) => {
  const actor = item.parent;
  if (actor && state.roomIds[actor.id]) schedulePush(actor);
});

// ── Dialog de pareo ───────────────────────────────────────────────────────────
async function openSyncDialog(actor) {
  const roomId = state.roomIds[actor.id];

  if (roomId) {
    // Ya está conectado — mostrar opciones
    new Dialog({
      title: `Bertini Sync — ${actor.name}`,
      content: `
        <div style="font-family:Georgia,serif;padding:8px">
          <p>✅ <strong>${actor.name}</strong> está conectado a la Cheat Sheet web.</p>
          <p style="font-size:12px;color:#888">Sala: <code>${roomId.slice(0,8)}…</code></p>
        </div>`,
      buttons: {
        disconnect: {
          label: 'Desconectar',
          icon: '<i class="fas fa-unlink"></i>',
          callback: () => disconnect(actor),
        },
        close: { label: 'Cerrar' },
      },
    }).render(true);
    return;
  }

  // Generar código de pareo
  let code;
  try {
    const res = await fetch(`${SYNC_URL}/__sync/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actorId:   actor.id,
        actorName: actor.name,
        userId:    game.user.id,
        worldId:   game.world.id,
      }),
    });
    ({ code } = await res.json());
  } catch (e) {
    ui.notifications.error('Bertini Sync | No se pudo conectar con el servidor.');
    return;
  }

  // Mostrar código al jugador
  new Dialog({
    title: `Conectar ${actor.name}`,
    content: `
      <div style="font-family:Georgia,serif;text-align:center;padding:16px">
        <p style="margin:0 0 8px;color:#888;font-size:13px">Ingresá este código en la Cheat Sheet web</p>
        <div style="font-size:36px;font-weight:bold;letter-spacing:0.15em;color:#c0392b;margin:12px 0">${code}</div>
        <p style="margin:0;font-size:12px;color:#666">Expira en 5 minutos</p>
      </div>`,
    buttons: {
      close: { label: 'Cerrar' },
    },
  }).render(true);

  // Esperar a que la web se conecte (polling por 5 min)
  waitForPair(actor, code);
}

// ── Esperar a que la web reclame el código ────────────────────────────────────
async function waitForPair(actor, code) {
  const deadline = Date.now() + 5 * 60 * 1000;

  const check = async () => {
    if (Date.now() > deadline) return;
    if (state.roomIds[actor.id]) return; // ya se conectó

    // Verificar si el código fue reclamado chequeando el KV
    // (el módulo no necesita saber — simplemente cuando la web llame a /pair
    // la sala queda activa. Si el módulo hace push y la sala existe, funciona)
    // Mejor: pushear inmediatamente con el actorId como roomId temporal
    // y la web sabrá cuándo conectarse
    setTimeout(check, 3000);
  };

  // La forma más simple: cuando la web reclama el código, recibe el roomId.
  // El módulo no necesita confirmación — simplemente inicia el push loop.
  // Cuando el Worker recibe un push y no hay sala, lo ignora silenciosamente.
  // Así que iniciamos el push de todas formas con un roomId provisional.

  // Pedir el roomId que el Worker asignó
  await pollForRoomId(actor, code, deadline);
}

async function pollForRoomId(actor, code, deadline) {
  if (Date.now() > deadline || state.roomIds[actor.id]) return;

  // No podemos saber si la web ya reclamó el código desde el módulo.
  // Solución: al generar el código, el Worker también guarda pair→roomId.
  // Hacemos GET a /__sync/paircheck?code=XXX para ver si fue reclamado.
  try {
    const res = await fetch(`${SYNC_URL}/__sync/paircheck?code=${code}`);
    if (res.ok) {
      const { roomId, actorName } = await res.json();
      if (roomId) {
        state.roomIds[actor.id] = roomId;
        await actor.setFlag('bertini-sync', 'roomId', roomId);
        startPushing(actor);
        ui.notifications.info(`Bertini Sync | ${actor.name} conectado a la Cheat Sheet ✓`);
        return;
      }
    }
  } catch (_) {}

  setTimeout(() => pollForRoomId(actor, code, deadline), 3000);
}

// ── Push del estado del actor ─────────────────────────────────────────────────
function schedulePush(actor) {
  // Debounce: esperar 500ms antes de pushear para acumular cambios
  clearTimeout(state.timers[`debounce_${actor.id}`]);
  state.timers[`debounce_${actor.id}`] = setTimeout(() => pushState(actor), 500);
}

function startPushing(actor) {
  // Push inmediato + push periódico como heartbeat
  pushState(actor);
  state.timers[actor.id] = setInterval(() => pushState(actor), 30000);
}

async function pushState(actor) {
  const roomId = state.roomIds[actor.id];
  if (!roomId) return;

  const actorData = actor.system;
  const hp = actorData.attributes?.hp;

  // Condiciones activas
  const conditions = actor.effects
    .filter(e => !e.disabled && e.statuses?.size > 0)
    .flatMap(e => [...e.statuses]);

  // Concentración
  const concentrating = actor.effects.find(e =>
    [...(e.statuses || [])].includes('concentrating') ||
    e.name?.toLowerCase().includes('concentrat')
  );
  const concentrationSpell = concentrating?.name?.replace(/concentrat(ing|ion)\s*(on\s*)?/i, '').trim() || null;

  // Spell slots
  const slots = {};
  const spellData = actorData.spells || {};
  for (let i = 1; i <= 9; i++) {
    const sl = spellData[`spell${i}`];
    if (sl && sl.max > 0) slots[i] = { value: sl.value, max: sl.max };
  }

  // Recursos (resources, ki, rage, bardic inspiration, etc.)
  const resources = {};
  const res = actorData.resources || {};
  for (const [key, val] of Object.entries(res)) {
    if (val?.max > 0) resources[key] = { value: val.value, max: val.max, label: val.label || key };
  }
  // Rage (Barbarian)
  if (actorData.attributes?.rage) {
    resources.rage = { value: actorData.attributes.rage.value, max: actorData.attributes.rage.max, label: 'Furia' };
  }

  const newState = {
    name: actor.name,
    hp: hp ? { value: hp.value, max: hp.max, temp: hp.temp || 0 } : null,
    conditions: [...new Set(conditions)],
    concentration: concentrating ? { active: true, spell: concentrationSpell } : { active: false },
    slots,
    resources,
  };

  // No pushear si no hubo cambios
  const newJson = JSON.stringify(newState);
  if (state.lastPush[actor.id] === newJson) return;
  state.lastPush[actor.id] = newJson;

  try {
    await fetch(`${SYNC_URL}/__sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, state: newState }),
    });
  } catch (_) { /* silencioso */ }
}

// ── Desconectar ───────────────────────────────────────────────────────────────
async function disconnect(actor) {
  clearInterval(state.timers[actor.id]);
  delete state.timers[actor.id];
  delete state.roomIds[actor.id];
  delete state.lastPush[actor.id];
  await actor.unsetFlag('bertini-sync', 'roomId');
  ui.notifications.info(`Bertini Sync | ${actor.name} desconectado.`);
}

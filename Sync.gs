/**
 * Calendar Sync - motore di sincronizzazione (da 2 a N calendari)
 *
 * Ogni calendario scelto mostra come blocchi "Occupato" gli eventi reali
 * di tutti gli altri. I blocchi sono marcati internamente, quindi:
 *  - non vengono mai ricopiati (niente cicli)
 *  - si aggiornano o spariscono se l'evento originale cambia o viene cancellato
 *  - si possono rimuovere tutti con un clic
 *
 * Richiede il servizio avanzato "Google Calendar API" (identificatore: Calendar).
 */

const MIRROR_FLAG = 'cs_mirror';   // marca un evento come "creato da Calendar Sync"
const SRC_CAL = 'cs_srcCal';       // calendario da cui proviene il blocco
const SRC_EVENT = 'cs_srcEvent';   // evento originale da cui proviene il blocco

const TRIGGER_HANDLERS_ = ['sincronizzaPeriodica', 'allaModificaCalendario'];
const MAX_REALTIME_TRIGGERS_ = 15;

// ==========================================
// PUNTI DI INGRESSO (trigger)
// ==========================================
function sincronizzaPeriodica() {
  if (!getSettings_().active) return;
  eseguiSincronizzazione_(4 * 60 * 1000);
}

function allaModificaCalendario() {
  if (!getSettings_().active) return;
  // Le nostre stesse scritture fanno scattare questo trigger: se abbiamo appena
  // finito un giro, saltiamo, cosi' non si crea un ciclo.
  const last = Number(PropertiesService.getUserProperties().getProperty('cs_lastRunMs') || 0);
  if (Date.now() - last < 45000) return;
  eseguiSincronizzazione_(4 * 60 * 1000);
}

// ==========================================
// SINCRONIZZAZIONE
// ==========================================
/**
 * @param {number} budgetMs tempo massimo a disposizione; se finisce prima, il giro e'
 *   parziale e riprende alla prossima esecuzione (l'algoritmo e' idempotente).
 */
function eseguiSincronizzazione_(budgetMs) {
  const lock = LockService.getUserLock();
  if (!lock.tryLock(20000)) return { busy: true };

  const props = PropertiesService.getUserProperties();
  const deadline = Date.now() + (budgetMs || 240000);
  CS_CACHE_ = null;
  try {
    const cfg = getSettings_();
    const coppie = coppie_(cfg);
    if (!coppie.length) return { skipped: true };

    verificaAccessi_(cfg);

    const win = finestra_(cfg);
    const dati = caricaTutti_(cfg.calendars, win);
    const stats = { creati: 0, aggiornati: 0, eliminati: 0 };

    let completo = true;
    for (let i = 0; i < coppie.length && completo; i++) {
      completo = rispecchia_(coppie[i][0], coppie[i][1], dati, cfg, stats, deadline);
    }
    // Blocchi che non hanno piu' motivo di esistere (es. dopo un cambio di modalita')
    if (completo) completo = pulisciEstranei_(coppie, cfg, dati, stats, deadline);
    if (!completo) stats.parziale = true;

    props.setProperty('cs_lastRun', new Date().toISOString());
    props.setProperty('cs_lastRunMs', String(Date.now()));
    props.setProperty('cs_lastStats', JSON.stringify(stats));
    props.deleteProperty('cs_lastError');
    Logger.log('Sincronizzazione: ' + JSON.stringify(stats));
    return stats;
  } catch (err) {
    props.setProperty('cs_lastError', String(err.message || err));
    Logger.log('Errore di sincronizzazione: ' + err);
    return { error: String(err.message || err) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Elenco delle coppie [origine, destinazione] da sincronizzare.
 *  - 'both':   ogni calendario riceve gli impegni di tutti gli altri
 *  - 'oneway': solo l'origine scelta manda i suoi impegni agli altri
 */
function coppie_(cfg) {
  const ids = cfg.calendars || [];
  const out = [];
  if (cfg.mode === 'oneway') {
    if (!cfg.sourceId) return out;
    ids.forEach(function (d) {
      if (d !== cfg.sourceId) out.push([cfg.sourceId, d]);
    });
  } else {
    if (ids.length < 2) return out;
    ids.forEach(function (s) {
      ids.forEach(function (d) {
        if (s !== d) out.push([s, d]);
      });
    });
  }
  return out;
}

/** Elimina i blocchi la cui sorgente non fa piu' parte di nessuna coppia valida. */
function pulisciEstranei_(coppie, cfg, dati, stats, deadline) {
  const validi = {};
  coppie.forEach(function (p) {
    if (!validi[p[1]]) validi[p[1]] = {};
    validi[p[1]][p[0]] = true;
  });
  for (let i = 0; i < cfg.calendars.length; i++) {
    const dst = cfg.calendars[i];
    const lista = dati[dst] || [];
    for (let j = 0; j < lista.length; j++) {
      const p = privati_(lista[j]);
      if (p && p[MIRROR_FLAG] && !(validi[dst] && validi[dst][p[SRC_CAL]])) {
        if (scaduto_(deadline)) return false;
        elimina_(dst, lista[j].id);
        stats.eliminati++;
      }
    }
  }
  return true;
}

/** Legge una sola volta gli eventi di ogni calendario nella finestra scelta. */
function caricaTutti_(ids, win) {
  const dati = {};
  ids.forEach(function (id) {
    dati[id] = listAll_(id, {
      timeMin: win.min, timeMax: win.max,
      singleEvents: true, showDeleted: false, maxResults: 250
    });
  });
  return dati;
}

/**
 * Allinea i blocchi in dstId con gli eventi reali di srcId.
 * Ritorna false se il tempo e' finito prima di completare (nessuna cancellazione
 * di "orfani" viene fatta in quel caso, per non eliminare blocchi validi).
 */
function rispecchia_(srcId, dstId, dati, cfg, stats, deadline) {
  const srcEvents = dati[srcId] || [];
  const dstEvents = dati[dstId] || [];

  // Eventi reali gia' presenti in destinazione (es. un invito condiviso tra i due
  // calendari): non serve duplicarli con un blocco.
  const giaPresenti = {};
  dstEvents.forEach(function (ev) {
    if (!isMirror_(ev)) giaPresenti[chiave_(ev)] = true;
  });

  // Cosa deve esserci
  const wanted = {};
  srcEvents.forEach(function (ev) {
    if (devoCopiare_(ev, cfg) && !giaPresenti[chiave_(ev)]) wanted[ev.id] = ev;
  });

  // Cosa c'e' gia' (blocchi creati in passato da questa sorgente)
  const existing = {};
  const doppioni = [];
  dstEvents.forEach(function (ev) {
    const p = privati_(ev);
    if (p && p[MIRROR_FLAG] && p[SRC_CAL] === srcId) {
      const k = p[SRC_EVENT];
      if (existing[k]) doppioni.push(ev); else existing[k] = ev;
    }
  });

  for (let i = 0; i < doppioni.length; i++) {
    if (scaduto_(deadline)) return false;
    elimina_(dstId, doppioni[i].id);
    stats.eliminati++;
  }

  // Crea o aggiorna
  const keys = Object.keys(wanted);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const src = wanted[key];
    const mirror = existing[key];
    const nuovo = corpo_(src, srcId, dstId, cfg);
    if (!mirror) {
      if (scaduto_(deadline)) return false;
      creaBlocco_(src, srcId, dstId, cfg, nuovo);
      stats.creati++;
    } else {
      if (cambiato_(mirror, nuovo)) {
        if (scaduto_(deadline)) return false;
        if (tipoDiverso_(mirror, nuovo)) {
          // Il tipo di un evento non si puo' cambiare (es. vecchio "Occupato" che ora
          // deve essere un vero "Fuori sede"): si elimina e si ricrea.
          elimina_(dstId, mirror.id);
          creaBlocco_(src, srcId, dstId, cfg, nuovo);
        } else {
          const modifica = {
            summary: nuovo.summary, start: nuovo.start, end: nuovo.end,
            visibility: nuovo.visibility || 'default'
          };
          if (nuovo.outOfOfficeProperties) modifica.outOfOfficeProperties = nuovo.outOfOfficeProperties;
          retry_(function () {
            return Calendar.Events.patch(modifica, dstId, mirror.id, { sendUpdates: 'none' });
          });
        }
        stats.aggiornati++;
      }
      delete existing[key];
    }
  }

  // Quello che resta non ha piu' una sorgente valida (cancellata, spostata fuori
  // finestra, rifiutata, segnata "Libero"...): via
  const orfani = Object.keys(existing);
  for (let i = 0; i < orfani.length; i++) {
    if (scaduto_(deadline)) return false;
    elimina_(dstId, existing[orfani[i]].id);
    stats.eliminati++;
  }
  return true;
}

// ==========================================
// REGOLE: quali eventi copiare
// ==========================================
function devoCopiare_(ev, cfg) {
  if (ev.status === 'cancelled') return false;
  if (isMirror_(ev)) return false;   // mai ricopiare i nostri blocchi (niente cicli)

  // Solo eventi normali e assenze (no luoghi di lavoro, focus time, compleanni...)
  if (ev.eventType && ['default', 'outOfOffice'].indexOf(ev.eventType) === -1) return false;

  if (cfg.skipFree && ev.transparency === 'transparent') return false;

  if (cfg.skipDeclined) {
    const rifiutato = (ev.attendees || []).some(function (p) {
      return p.self && p.responseStatus === 'declined';
    });
    if (rifiutato) return false;
  }

  if (ev.start && ev.start.date && !cfg.includeAllDay) return false;

  const testo = ((ev.summary || '') + ' ' + (ev.description || '')).toLowerCase();
  const escluso = (cfg.skipKeywords || []).some(function (k) {
    return k && testo.indexOf(String(k).toLowerCase()) >= 0;
  });
  return !escluso;
}

// ==========================================
// COSTRUZIONE E CONFRONTO DEGLI EVENTI
// ==========================================
function corpo_(src, srcId, dstId, cfg) {
  const ooo = voglioOOO_(src, dstId);
  const nome = !ooo && mostraNome_(src, cfg);
  const body = {
    summary: ooo ? (src.summary || 'Fuori sede') : (nome ? src.summary : cfg.title),
    transparency: 'opaque',
    reminders: { useDefault: false },
    extendedProperties: { private: {} }
  };
  body.extendedProperties.private[MIRROR_FLAG] = '1';
  body.extendedProperties.private[SRC_CAL] = srcId;
  body.extendedProperties.private[SRC_EVENT] = src.id;

  if (ooo) {
    // Vero "Fuori sede", con le stesse impostazioni dell'originale
    body.eventType = 'outOfOffice';
    body.outOfOfficeProperties = JSON.parse(JSON.stringify(
      src.outOfOfficeProperties || { autoDeclineMode: 'declineNone' }));
    if (src.visibility) body.visibility = src.visibility;
  } else {
    // Con il nome vero il blocco deve essere leggibile da chi vede il calendario,
    // quindi non lo rendiamo privato; con "Occupato" resta privato.
    if (!nome) body.visibility = 'private';
    if (cfg.colorId) body.colorId = cfg.colorId;
  }

  if (src.start.date) {
    body.start = { date: src.start.date };
    body.end = { date: src.end.date };
  } else {
    body.start = { dateTime: src.start.dateTime, timeZone: src.start.timeZone };
    body.end = { dateTime: src.end.dateTime, timeZone: src.end.timeZone };
  }
  return body;
}

/**
 * Il nome vero si mostra solo se l'opzione e' attiva, l'evento ha un titolo e
 * non e' privato o riservato: in quel caso resta sempre "Occupato".
 */
function mostraNome_(src, cfg) {
  return !!cfg.showTitles && !!src.summary &&
    src.visibility !== 'private' && src.visibility !== 'confidential';
}

function cambiato_(mirror, body) {
  return tipoDiverso_(mirror, body) ||
    mirror.summary !== body.summary ||
    (mirror.visibility || 'default') !== (body.visibility || 'default') ||
    !stessoOrario_(mirror.start, body.start) ||
    !stessoOrario_(mirror.end, body.end) ||
    !stesseProprietaOOO_(mirror, body);
}

function tipoDiverso_(mirror, body) {
  return (mirror.eventType === 'outOfOffice') !== (body.eventType === 'outOfOffice');
}

function stesseProprietaOOO_(mirror, body) {
  if (body.eventType !== 'outOfOffice') return true;
  const x = mirror.outOfOfficeProperties || {};
  const y = body.outOfOfficeProperties || {};
  return (x.autoDeclineMode || '') === (y.autoDeclineMode || '') &&
    (x.declineMessage || '') === (y.declineMessage || '');
}

// ==========================================
// FUORI SEDE
// ==========================================
let CS_CACHE_ = null;   // vale solo per la durata di una esecuzione

function cacheCs_() {
  if (!CS_CACHE_) {
    CS_CACHE_ = {
      primaria: {},
      oooKo: PropertiesService.getUserProperties().getProperty('cs_oooKo') === '1'
    };
  }
  return CS_CACHE_;
}

/** Google permette di creare eventi "Fuori sede" solo sul calendario principale. */
function primaria_(calId) {
  const c = cacheCs_();
  if (!(calId in c.primaria)) {
    try {
      c.primaria[calId] = Calendar.CalendarList.get(calId).primary === true;
    } catch (e) {
      c.primaria[calId] = false;
    }
  }
  return c.primaria[calId];
}

function voglioOOO_(src, dstId) {
  if (src.eventType !== 'outOfOffice' || !(src.start && src.start.dateTime)) return false;
  if (cacheCs_().oooKo) return false;
  return primaria_(dstId);
}

/**
 * Crea il blocco. Se Google rifiuta il "Fuori sede" (per esempio perche' il tipo non
 * e' disponibile sul tuo account), ricorda il rifiuto e crea un normale blocco "Occupato".
 */
function creaBlocco_(src, srcId, dstId, cfg, body) {
  try {
    retry_(function () { return Calendar.Events.insert(body, dstId, { sendUpdates: 'none' }); });
  } catch (e) {
    if (body.eventType !== 'outOfOffice') throw e;
    Logger.log('Fuori sede non creabile, uso un blocco normale: ' + e);
    PropertiesService.getUserProperties().setProperty('cs_oooKo', '1');
    cacheCs_().oooKo = true;
    const normale = corpo_(src, srcId, dstId, cfg);
    retry_(function () { return Calendar.Events.insert(normale, dstId, { sendUpdates: 'none' }); });
  }
}

function stessoOrario_(x, y) {
  if (x.date || y.date) return x.date === y.date;
  return new Date(x.dateTime).getTime() === new Date(y.dateTime).getTime();
}

function privati_(ev) {
  return ev.extendedProperties && ev.extendedProperties.private;
}

function isMirror_(ev) {
  const p = privati_(ev);
  return !!(p && p[MIRROR_FLAG]);
}

/** Identifica "lo stesso evento" in due calendari diversi (stesso invito, stesso orario). */
function chiave_(ev) {
  const inizio = ev.start && (ev.start.dateTime ? new Date(ev.start.dateTime).getTime() : ev.start.date);
  return (ev.iCalUID || ev.id) + '|' + inizio;
}

// ==========================================
// PULIZIA
// ==========================================
/**
 * Elimina i blocchi creati dallo script in calendario calId.
 * Se srcCalId e' indicato, solo quelli che provengono da quel calendario.
 */
function rimuoviBlocchi_(calId, srcCalId) {
  const filtro = srcCalId ? (SRC_CAL + '=' + srcCalId) : (MIRROR_FLAG + '=1');
  const items = listAll_(calId, {
    showDeleted: false, maxResults: 250, privateExtendedProperty: filtro
  });
  items.forEach(function (ev) { elimina_(calId, ev.id); });
  return items.length;
}

/** Quando un calendario viene tolto dalla selezione, ripulisce i suoi blocchi e quelli che ha generato. */
function pulisciRimossi_(vecchi, tolti) {
  tolti.forEach(function (r) {
    try { rimuoviBlocchi_(r, null); } catch (e) { Logger.log('Pulizia ' + r + ': ' + e); }
    vecchi.forEach(function (c) {
      if (tolti.indexOf(c) !== -1) return;
      try { rimuoviBlocchi_(c, r); } catch (e) { Logger.log('Pulizia ' + c + ': ' + e); }
    });
  });
}

// ==========================================
// TRIGGER
// ==========================================
function rimuoviTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (TRIGGER_HANDLERS_.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
}

/**
 * Crea il trigger orario (obbligatorio: negli add-on non puo' essere piu' frequente)
 * e, se Google lo permette, un trigger "a ogni modifica" per ogni calendario.
 * Ritorna quanti trigger in tempo reale sono stati creati.
 */
function installaTrigger_(cfg) {
  rimuoviTrigger_();
  ScriptApp.newTrigger('sincronizzaPeriodica').timeBased().everyHours(1).create();

  // In 'oneway' basta controllare le modifiche dell'origine
  const daControllare = (cfg.mode === 'oneway' && cfg.sourceId) ? [cfg.sourceId] : cfg.calendars;

  let realtime = 0;
  daControllare.slice(0, MAX_REALTIME_TRIGGERS_).forEach(function (id) {
    try {
      ScriptApp.newTrigger('allaModificaCalendario').forUserCalendar(id).onEventUpdated().create();
      realtime++;
    } catch (e) {
      Logger.log('Trigger in tempo reale non creato per ' + id + ': ' + e);
    }
  });
  return realtime;
}

// ==========================================
// UTILITA'
// ==========================================
function finestra_(cfg) {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  return {
    min: new Date(now - cfg.daysBehind * day).toISOString(),
    max: new Date(now + cfg.daysAhead * day).toISOString()
  };
}

function scaduto_(deadline) {
  return Date.now() > deadline;
}

/** Scorre tutte le pagine di risultati. */
function listAll_(calId, params) {
  const out = [];
  let token = null;
  do {
    const p = Object.assign({}, params);
    if (token) p.pageToken = token;
    const res = retry_(function () { return Calendar.Events.list(calId, p); });
    (res.items || []).forEach(function (ev) { out.push(ev); });
    token = res.nextPageToken;
  } while (token);
  return out;
}

function elimina_(calId, eventId) {
  try {
    retry_(function () { return Calendar.Events.remove(calId, eventId, { sendUpdates: 'none' }); });
  } catch (e) {
    // gia' eliminato (410) o non piu' presente (404): va bene cosi'
    if (!/Resource has been deleted|Not Found|410|404/i.test(String(e.message))) throw e;
  }
}

/** Riprova con attesa crescente in caso di limiti temporanei di Google. */
function retry_(fn) {
  for (let i = 0; i < 4; i++) {
    try {
      return fn();
    } catch (e) {
      const temporaneo = /rate limit|quota|backend|internal error|503|500|429/i.test(String(e.message));
      if (!temporaneo || i === 3) throw e;
      Utilities.sleep(500 * Math.pow(2, i));
    }
  }
}

/**
 * Controlla i permessi e spiega chiaramente cosa manca.
 *  - calendari che ricevono blocchi: serve poter modificare gli eventi
 *  - calendario di origine in 'oneway': basta poter vedere i dettagli degli eventi
 */
function verificaAccessi_(cfg) {
  const problemi = [];
  cfg.calendars.forEach(function (id) {
    const soloOrigine = (cfg.mode === 'oneway' && id === cfg.sourceId);
    const ammessi = soloOrigine ? ['owner', 'writer', 'reader'] : ['owner', 'writer'];
    const r = ruolo_(id);
    if (ammessi.indexOf(r) === -1) problemi.push(id + ' (permesso attuale: ' + r + ')');
  });
  if (problemi.length) {
    throw new Error('Permessi insufficienti su: ' + problemi.join('; ') +
      '. Per il calendario di origine serve almeno "Visualizza tutti i dettagli degli eventi", ' +
      'per quelli che ricevono i blocchi "Apporta modifiche agli eventi".');
  }
}

function ruolo_(calId) {
  try {
    return Calendar.CalendarList.get(calId).accessRole;
  } catch (e) {
    return 'nessun accesso: il calendario e\' nella tua lista?';
  }
}

/**
 * Calendari dell'utente (almeno in lettura), con nome leggibile e fuso orario.
 * "writable" indica se si possono modificare gli eventi (serve per ricevere i blocchi).
 */
function listaCalendari_() {
  const items = [];
  let tz = null;
  let token = null;
  do {
    const p = { minAccessRole: 'freeBusyReader', showHidden: false, maxResults: 250 };
    if (token) p.pageToken = token;
    const res = retry_(function () { return Calendar.CalendarList.list(p); });
    (res.items || []).forEach(function (c) {
      if (c.primary) tz = c.timeZone;
      // salta i calendari automatici di Google (festivita', compleanni, numero della settimana)
      if (/#holiday@|addressbook#contacts@|#weeknum@/.test(c.id)) return;
      items.push({
        id: c.id,
        name: (c.summaryOverride || c.summary || c.id),
        primary: !!c.primary,
        // "readable": si vedono i dettagli degli eventi (serve per usarlo come origine)
        readable: ['owner', 'writer', 'reader'].indexOf(c.accessRole) !== -1,
        writable: c.accessRole === 'owner' || c.accessRole === 'writer'
      });
    });
    token = res.nextPageToken;
  } while (token);
  items.sort(function (a, b) {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { items: items, tz: tz };
}

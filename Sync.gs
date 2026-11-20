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
    dati[id] = (ruolo_(id) === 'freeBusyReader')
      ? eventiDaLiberoOccupato_(id, win)
      : listAll_(id, {
        timeMin: win.min, timeMax: win.max,
        singleEvents: true, showDeleted: false, maxResults: 250
      });
  });
  return dati;
}

/**
 * Calendario condiviso solo come "libero/occupato": non ci sono eventi leggibili,
 * ma Google fornisce gli intervalli occupati. Li trasformiamo in eventi sintetici
 * (senza titolo) con un identificativo ricavato da inizio e fine: se l'intervallo
 * cambia, il vecchio blocco sparisce e ne nasce uno nuovo.
 */
function eventiDaLiberoOccupato_(calId, win) {
  const res = retry_(function () {
    return Calendar.Freebusy.query({ timeMin: win.min, timeMax: win.max, items: [{ id: calId }] });
  });
  const c = res.calendars && res.calendars[calId];
  if (!c) throw new Error('Non riesco a leggere gli orari di ' + calId + '.');
  if (c.errors && c.errors.length) {
    // Si ferma qui: meglio non toccare nulla che cancellare blocchi validi per un errore passeggero
    throw new Error('Non riesco a leggere gli orari di ' + calId + ' (' + c.errors[0].reason + ').');
  }
  return (c.busy || []).map(function (b) {
    const id = 'fb:' + b.start + '|' + b.end;
    return {
      id: id, iCalUID: id, status: 'confirmed', summary: '', eventType: 'default',
      transparency: 'opaque', start: { dateTime: b.start }, end: { dateTime: b.end }
    };
  });
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
  const fuoriSedeDst = [];
  dstEvents.forEach(function (ev) {
    if (isMirror_(ev)) return;
    giaPresenti[chiave_(ev)] = true;
    if (ev.eventType === 'outOfOffice' && ev.status !== 'cancelled') fuoriSedeDst.push(ev);
  });

  // Cosa deve esserci
  const wanted = {};
  srcEvents.forEach(function (ev) {
    if (!devoCopiare_(ev, cfg) || giaPresenti[chiave_(ev)]) return;
    // Se in destinazione c'e' gia' un "Fuori sede" che copre quel periodo non serve
    // nessun blocco. Vale anche per gli orari dei calendari "libero/occupato", dove
    // non si puo' sapere se l'impegno di origine era a sua volta un "Fuori sede".
    if (copertoDa_(ev, fuoriSedeDst)) return;
    wanted[ev.id] = ev;
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
        if (tipoDiverso_(mirror, nuovo) || mirror.colorId) {
          // Il tipo di un evento non si puo' cambiare (es. vecchio "Occupato" che ora
          // deve essere un vero "Fuori sede"): si elimina e si ricrea. Lo stesso per i
          // vecchi blocchi con un colore fisso, cosi' tornano al colore del calendario.
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
    !!mirror.colorId ||
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
    let ko = {};
    try { ko = JSON.parse(PropertiesService.getUserProperties().getProperty('cs_oooKo') || '{}'); } catch (e) { ko = {}; }
    CS_CACHE_ = {
      primaria: {},
      oooKo: (ko && typeof ko === 'object') ? ko : {}   // calendari su cui Google ha rifiutato il "Fuori sede"
    };
  }
  return CS_CACHE_;
}

/** Il calendario e' il tuo calendario principale? */
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

/**
 * Google permette i "Fuori sede" solo sui calendari principali: il tuo, oppure
 * quello di un altro account condiviso con te (il suo id e' un indirizzo email).
 * I calendari secondari (...@group.calendar.google.com) non li accettano.
 */
function accettaOOO_(calId) {
  if (primaria_(calId)) return true;
  return calId.indexOf('@') > 0 && calId.indexOf('#') === -1 && !/calendar\.google\.com$/i.test(calId);
}

function voglioOOO_(src, dstId) {
  if (src.eventType !== 'outOfOffice' || !(src.start && src.start.dateTime)) return false;
  if (cacheCs_().oooKo[dstId]) return false;
  return accettaOOO_(dstId);
}

/**
 * L'evento ev e' interamente coperto dai "Fuori sede" reali della destinazione?
 * I "Fuori sede" consecutivi o sovrapposti vengono uniti: due giorni separati
 * (23 e 24) coprono un unico intervallo occupato dal 23 al 25.
 */
function copertoDa_(ev, fuoriSede) {
  const s = ms_(ev.start), e = ms_(ev.end);
  if (isNaN(s) || isNaN(e)) return false;
  const intervalli = fuoriSede
    .map(function (d) { return [ms_(d.start), ms_(d.end)]; })
    .filter(function (x) { return !isNaN(x[0]) && !isNaN(x[1]); })
    .sort(function (a, b) { return a[0] - b[0]; });
  let coperto = s;   // fin dove l'evento risulta gia' coperto
  for (let i = 0; i < intervalli.length && coperto < e; i++) {
    if (intervalli[i][0] > coperto) break;   // buco scoperto: essendo ordinati, nessuno dopo lo chiude
    if (intervalli[i][1] > coperto) coperto = intervalli[i][1];
  }
  return coperto >= e;
}

function ms_(t) {
  if (!t) return NaN;
  return t.dateTime ? new Date(t.dateTime).getTime() : new Date(t.date).getTime();
}

/**
 * Crea il blocco. Se Google rifiuta il "Fuori sede" su quel calendario, ricorda il
 * rifiuto (solo per quel calendario) e crea un normale blocco "Occupato".
 */
function creaBlocco_(src, srcId, dstId, cfg, body) {
  try {
    retry_(function () { return Calendar.Events.insert(body, dstId, { sendUpdates: 'none' }); });
  } catch (e) {
    if (body.eventType !== 'outOfOffice') throw e;
    Logger.log('Fuori sede non creabile su ' + dstId + ', uso un blocco normale: ' + e);
    const c = cacheCs_();
    c.oooKo[dstId] = true;
    PropertiesService.getUserProperties().setProperty('cs_oooKo', JSON.stringify(c.oooKo));
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
  CS_CACHE_ = null;   // permessi riletti da zero a ogni controllo
  const problemi = [];
  cfg.calendars.forEach(function (id) {
    const soloOrigine = (cfg.mode === 'oneway' && id === cfg.sourceId);
    const ammessi = soloOrigine ? ['owner', 'writer', 'reader', 'freeBusyReader'] : ['owner', 'writer'];
    const r = ruolo_(id);
    if (ammessi.indexOf(r) === -1) problemi.push(id + ' (permesso attuale: ' + r + ')');
  });
  if (problemi.length) {
    throw new Error('Permessi insufficienti su: ' + problemi.join('; ') +
      '. Per il calendario di origine basta anche solo "libero/occupato"; per quelli che ' +
      'ricevono i blocchi, e per il doppio senso, serve "Apporta modifiche agli eventi".');
  }
}

function ruolo_(calId) {
  const c = cacheCs_();
  if (!c.ruoli) c.ruoli = {};
  if (!(calId in c.ruoli)) {
    try {
      c.ruoli[calId] = Calendar.CalendarList.get(calId).accessRole;
    } catch (e) {
      c.ruoli[calId] = 'nessun accesso: il calendario e\' nella tua lista?';
    }
  }
  return c.ruoli[calId];
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

/**
 * Calendar Sync - scheda nel pannello laterale di Google Calendar (Card Service).
 *
 * Un solo percorso:
 *   1. da quale calendario prendere gli impegni
 *   2. su quali calendari mostrarli
 *   3. (facoltativo) sincronizzare anche al contrario
 */

// ==========================================
// PAGINA INIZIALE
// ==========================================
function onHomepage() {
  return buildHome_();
}

/**
 * @param {Object=} bozza scelte non ancora salvate (usate quando la scheda si
 *   ridisegna dopo la scelta dell'origine, per non far perdere quanto inserito)
 */
function buildHome_(bozza) {
  const salvato = getSettings_();
  const cfg = Object.assign({}, salvato, bozza || {});

  let lista;
  try {
    lista = listaCalendari_();
  } catch (err) {
    return cardErrore_('Non riesco a leggere i tuoi calendari: ' + err.message);
  }
  const nomi = {};
  lista.items.forEach(function (c) { nomi[c.id] = c.name; });

  return CardService.newCardBuilder()
    .setName('home')
    .setHeader(CardService.newCardHeader().setTitle('Calendar Sync'))
    .addSection(sezioneStato_(salvato, lista.tz, nomi))
    .addSection(sezioneScelta_(cfg, lista.items))
    .addSection(sezioneOpzioni_(cfg, salvato))
    .addSection(sezionePulsanti_(salvato))
    .build();
}

// ==========================================
// SEZIONI DELLA SCHEDA
// ==========================================
function sezioneStato_(cfg, tz, nomi) {
  const props = PropertiesService.getUserProperties();
  const err = props.getProperty('cs_lastError');
  const last = props.getProperty('cs_lastRun');
  let stats = null;
  try { stats = JSON.parse(props.getProperty('cs_lastStats') || 'null'); } catch (e) { stats = null; }

  let testo;
  if (err) {
    testo = '<b>Errore.</b> ' + escapeHtml_(err);
  } else if (coppie_(cfg).length === 0) {
    testo = 'Scegli da dove prendere gli impegni e dove mostrarli.';
  } else if (!cfg.active) {
    testo = '<b>In pausa.</b> ' + descrizione_(cfg, nomi);
  } else {
    testo = '<b>Attivo.</b> ' + descrizione_(cfg, nomi);
    if (last) testo += '<br>Ultimo controllo: ' + formattaData_(last, tz);
    if (stats && stats.parziale) testo += '<br>Controllo incompleto, riprende al prossimo giro.';
  }
  return CardService.newCardSection()
    .addWidget(CardService.newTextParagraph().setText(testo));
}

function descrizione_(cfg, nomi) {
  const nome = escapeHtml_(nomi[cfg.sourceId] || cfg.sourceId || '');
  const altri = cfg.calendars.length - 1;
  if (cfg.mode === 'both') {
    return nome + ' e altri ' + altri + ' in entrambe le direzioni.';
  }
  return 'Da ' + nome + ' verso ' + altri + (altri === 1 ? ' calendario.' : ' calendari.');
}

function sezioneScelta_(cfg, tutti) {
  const scrivibili = tutti.filter(function (c) { return c.writable; });
  const sezione = CardService.newCardSection();

  const origine = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setFieldName('source')
    .setTitle('Prendi gli impegni da')
    .setOnChangeAction(CardService.newAction().setFunctionName('onCambiaOrigine'))
    .addItem('Scegli un calendario', '', !cfg.sourceId);
  tutti.forEach(function (c) {
    origine.addItem(c.name, c.id, c.id === cfg.sourceId);
  });
  sezione.addWidget(origine);

  const possibili = scrivibili.filter(function (c) { return c.id !== cfg.sourceId; });
  if (tutti.length < 2 || !possibili.length) {
    // Le istruzioni compaiono solo quando servono
    sezione.addWidget(CardService.newTextParagraph().setText(
      'Non trovo altri calendari su cui puoi scrivere. Se è di un altro account, fattelo condividere ' +
      'con il permesso “Apporta modifiche agli eventi”, accetta l’invito e riapri questo pannello.'));
  } else {
    const dest = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.CHECK_BOX)
      .setFieldName('cals')
      .setTitle('Mostrali su');
    possibili.forEach(function (c) {
      dest.addItem(c.name, c.id, cfg.calendars.indexOf(c.id) !== -1);
    });
    sezione.addWidget(dest);
  }

  sezione.addWidget(CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.SWITCH)
    .setFieldName('reverse')
    .addItem('Sincronizza anche al contrario', 'reverse', cfg.mode === 'both'));
  sezione.addWidget(CardService.newTextParagraph().setText(
    '<i>Senza questa opzione il primo calendario resta intatto e può essere anche in sola lettura.</i>'));
  return sezione;
}

function sezioneOpzioni_(cfg, salvato) {
  const sezione = CardService.newCardSection()
    .setHeader('Opzioni')
    .setCollapsible(true)
    .setNumUncollapsibleWidgets(0)
    .addWidget(CardService.newTextInput()
      .setFieldName('title')
      .setTitle('Titolo dei blocchi')
      .setValue(cfg.title))
    .addWidget(CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.SWITCH)
      .setFieldName('opts')
      .addItem('Mostra il nome vero degli impegni', 'titles', !!cfg.showTitles)
      .addItem('Includi gli eventi di tutto il giorno', 'allDay', !!cfg.includeAllDay)
      .addItem('Salta gli eventi rifiutati', 'declined', !!cfg.skipDeclined)
      .addItem('Salta gli eventi segnati come “Libero”', 'free', !!cfg.skipFree))
    .addWidget(CardService.newTextParagraph().setText(
      '<i>Con il nome vero, chi vede il calendario di destinazione legge il titolo. ' +
      'Gli eventi privati restano “Occupato”. Scrivi #nosync nel titolo di un evento per escluderlo.</i>'));

  if (coppie_(salvato).length > 0) {
    sezione.addWidget(CardService.newTextButton()
      .setText('Rimuovi tutti i blocchi')
      .setOnClickAction(CardService.newAction().setFunctionName('onChiediAnnulla')));
  }
  return sezione;
}

function sezionePulsanti_(salvato) {
  const set = CardService.newButtonSet().addButton(
    CardService.newTextButton()
      .setText(salvato.active ? 'Salva' : 'Attiva')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(CardService.newAction().setFunctionName('onSalva')));

  if (salvato.active && coppie_(salvato).length > 0) {
    set.addButton(CardService.newTextButton()
      .setText('Sincronizza ora')
      .setOnClickAction(CardService.newAction().setFunctionName('onSincronizzaOra')));
    set.addButton(CardService.newTextButton()
      .setText('Pausa')
      .setOnClickAction(CardService.newAction().setFunctionName('onPausa')));
  }
  return CardService.newCardSection().addWidget(set);
}

// ==========================================
// AZIONI DEI PULSANTI
// ==========================================
/** Legge tutto quello che l'utente ha inserito nella scheda. */
function leggiForm_(e) {
  const fi = e.formInput || {};
  const fis = e.formInputs || {};
  const opts = fis.opts || [];
  return {
    sourceId: fi.source || '',
    calendars: fis.cals || [],
    mode: (fis.reverse && fis.reverse.length) ? 'both' : 'oneway',
    title: fi.title !== undefined ? String(fi.title) : DEFAULTS_.title,
    showTitles: opts.indexOf('titles') !== -1,
    includeAllDay: opts.indexOf('allDay') !== -1,
    skipDeclined: opts.indexOf('declined') !== -1,
    skipFree: opts.indexOf('free') !== -1
  };
}

/** Scelta dell'origine: ridisegna la scheda (toglie l'origine dalle destinazioni) senza perdere le scelte. */
function onCambiaOrigine(e) {
  try {
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation().updateCard(buildHome_(leggiForm_(e))))
      .build();
  } catch (err) {
    return avviso_('Errore: ' + err.message);
  }
}

function onSalva(e) {
  try {
    const cfg = getSettings_();
    const f = leggiForm_(e);

    if (!f.sourceId) return avviso_('Scegli da quale calendario prendere gli impegni.');
    const dest = f.calendars.filter(function (id) { return id !== f.sourceId; });
    if (!dest.length) return avviso_('Scegli almeno un calendario su cui mostrarli.');
    const calendari = [f.sourceId].concat(dest);

    const nuovo = Object.assign({}, cfg, {
      mode: f.mode,
      sourceId: f.sourceId,
      calendars: calendari,
      title: f.title.trim().slice(0, 40) || DEFAULTS_.title,
      showTitles: f.showTitles,
      includeAllDay: f.includeAllDay,
      skipDeclined: f.skipDeclined,
      skipFree: f.skipFree,
      active: true
    });

    verificaAccessi_(nuovo);   // se manca un permesso, lo spiega prima di salvare

    const vecchi = cfg.calendars.slice();
    const tolti = vecchi.filter(function (id) { return calendari.indexOf(id) === -1; });
    pulisciRimossi_(vecchi, tolti);

    saveSettings_(nuovo);
    PropertiesService.getUserProperties().deleteProperty('cs_lastError');
    PropertiesService.getUserProperties().deleteProperty('cs_oooKo');   // riprova a creare i "Fuori sede"
    installaTrigger_(nuovo);
    return aggiorna_(messaggioSync_(eseguiSincronizzazione_(20000)));
  } catch (err) {
    return avviso_('Errore: ' + err.message);
  }
}

function onSincronizzaOra() {
  try {
    return aggiorna_(messaggioSync_(eseguiSincronizzazione_(20000)));
  } catch (err) {
    return avviso_('Errore: ' + err.message);
  }
}

function onPausa() {
  try {
    const cfg = getSettings_();
    rimuoviTrigger_();
    cfg.active = false;
    saveSettings_(cfg);
    return aggiorna_('In pausa. I blocchi già creati restano.');
  } catch (err) {
    return avviso_('Errore: ' + err.message);
  }
}

function onChiediAnnulla() {
  const card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Rimuovere i blocchi?'))
    .addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph().setText(
        'Elimino tutti i blocchi creati da Calendar Sync e fermo la sincronizzazione. ' +
        'I tuoi eventi non vengono toccati.'))
      .addWidget(CardService.newButtonSet()
        .addButton(CardService.newTextButton()
          .setText('Rimuovi')
          .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
          .setOnClickAction(CardService.newAction().setFunctionName('onAnnullaTutto')))
        .addButton(CardService.newTextButton()
          .setText('Indietro')
          .setOnClickAction(CardService.newAction().setFunctionName('onIndietro')))))
    .build();
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(card))
    .build();
}

function onIndietro() {
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().popCard())
    .build();
}

function onAnnullaTutto() {
  try {
    const cfg = getSettings_();
    rimuoviTrigger_();
    let n = 0;
    cfg.calendars.forEach(function (id) { n += rimuoviBlocchi_(id, null); });
    cfg.active = false;
    saveSettings_(cfg);
    const props = PropertiesService.getUserProperties();
    props.deleteProperty('cs_lastError');
    props.deleteProperty('cs_lastStats');
    return CardService.newActionResponseBuilder()
      .setNotification(CardService.newNotification().setText('Rimossi ' + n + ' blocchi.'))
      .setNavigation(CardService.newNavigation().popToRoot().updateCard(buildHome_()))
      .build();
  } catch (err) {
    return avviso_('Errore: ' + err.message);
  }
}

// ==========================================
// UTILITA' DELLA SCHEDA
// ==========================================
function aggiorna_(messaggio) {
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(messaggio))
    .setNavigation(CardService.newNavigation().updateCard(buildHome_()))
    .build();
}

function avviso_(messaggio) {
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(messaggio))
    .build();
}

function cardErrore_(messaggio) {
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Calendar Sync'))
    .addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph().setText(escapeHtml_(messaggio))))
    .build();
}

function messaggioSync_(stats) {
  if (!stats) return 'Fatto.';
  if (stats.busy) return 'Una sincronizzazione è già in corso.';
  if (stats.error) return 'Errore: ' + stats.error;
  if (stats.skipped) return 'Controlla i calendari scelti.';
  if (stats.parziale) return 'Avviata: proseguirà al prossimo controllo.';
  return 'Fatto: ' + stats.creati + ' creati, ' + stats.aggiornati + ' aggiornati, ' + stats.eliminati + ' rimossi.';
}

function formattaData_(iso, tz) {
  try {
    return Utilities.formatDate(new Date(iso), tz || 'UTC', 'dd/MM/yyyy HH:mm');
  } catch (e) {
    return iso;
  }
}

function escapeHtml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

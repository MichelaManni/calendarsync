/**
 * Calendar Sync - impostazioni salvate per ogni utente.
 * Al posto del vecchio blocco CONFIG: ora le scelte arrivano dalla scheda
 * nel pannello laterale e vengono salvate in UserProperties.
 */

const SETTINGS_KEY = 'cs_settings';

const DEFAULTS_ = {
  mode: 'both',                          // 'both' = doppio senso, 'oneway' = un solo senso
  sourceId: '',                          // solo per 'oneway': calendario da cui prendere gli impegni
  calendars: [],                         // tutti i calendari coinvolti (in 'oneway' include anche l'origine)
  title: 'Occupato',                     // titolo dei blocchi creati
  showTitles: false,                     // true = i blocchi riportano il nome vero dell'impegno
  includeAllDay: false,                  // copiare anche gli eventi "tutto il giorno"
  skipDeclined: true,                    // ignora gli eventi rifiutati
  skipFree: true,                        // ignora gli eventi segnati come "Libero"
  skipKeywords: ['#nosync', '#privato'], // se presenti nel titolo/descrizione, evento non copiato
  daysBehind: 1,                         // giorni nel passato da considerare
  daysAhead: 60,                         // giorni nel futuro da considerare
  active: false                          // sincronizzazione attiva o in pausa
};

function getSettings_() {
  const raw = PropertiesService.getUserProperties().getProperty(SETTINGS_KEY);
  let saved = {};
  if (raw) {
    try { saved = JSON.parse(raw); } catch (e) { saved = {}; }
  }
  return Object.assign({}, DEFAULTS_, saved);
}

function saveSettings_(cfg) {
  PropertiesService.getUserProperties().setProperty(SETTINGS_KEY, JSON.stringify(cfg));
}

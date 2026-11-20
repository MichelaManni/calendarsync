/**
 * Calendar Sync - diagnostica temporanea per i "Fuori sede".
 * Da eseguire dall'editor di Apps Script (funzione diagnosticaFuoriSede):
 * non modifica nulla, scrive solo nel registro di esecuzione.
 */
function diagnosticaFuoriSede() {
  CS_CACHE_ = null;
  const cfg = getSettings_();
  const coppie = coppie_(cfg);
  Logger.log('Modo: ' + cfg.mode + ' | origine: ' + cfg.sourceId + ' | calendari: ' + cfg.calendars.join(', '));
  cfg.calendars.forEach(function (id) { Logger.log('Permesso su ' + id + ': ' + ruolo_(id)); });
  Logger.log('copertoDa_ presente: ' + (typeof copertoDa_ === 'function'));

  const dati = caricaTutti_(cfg.calendars, finestra_(cfg));
  const fmt = function (t) { return t ? (t.dateTime || t.date) : '?'; };

  coppie.forEach(function (p) {
    const srcId = p[0], dstId = p[1];
    Logger.log('==== Da ' + srcId + ' verso ' + dstId);
    const ooo = (dati[dstId] || []).filter(function (ev) {
      return !isMirror_(ev) && ev.eventType === 'outOfOffice' && ev.status !== 'cancelled';
    });
    Logger.log('"Fuori sede" reali in destinazione: ' + ooo.length);

    ooo.forEach(function (d) {
      const ds = ms_(d.start), de = ms_(d.end);
      Logger.log('-- Fuori sede destinazione: ' + fmt(d.start) + ' -> ' + fmt(d.end));
      (dati[srcId] || []).forEach(function (ev) {
        if (ms_(ev.end) <= ds || ms_(ev.start) >= de) return;   // non si sovrappone
        Logger.log('   origine: ' + fmt(ev.start) + ' -> ' + fmt(ev.end) +
          ' | tipo ' + (ev.eventType || '-') + ' | da copiare ' + devoCopiare_(ev, cfg) +
          ' | coperto ' + copertoDa_(ev, ooo));
      });
      (dati[dstId] || []).forEach(function (ev) {
        if (!isMirror_(ev) || ms_(ev.end) <= ds || ms_(ev.start) >= de) return;
        Logger.log('   blocco gia\' creato: ' + fmt(ev.start) + ' -> ' + fmt(ev.end) +
          ' | "' + ev.summary + '" | da ' + privati_(ev)[SRC_CAL]);
      });
    });
  });

  const props = PropertiesService.getUserProperties();
  Logger.log('Ultimo giro: ' + props.getProperty('cs_lastRun') + ' | ' + props.getProperty('cs_lastStats'));
  Logger.log('Ultimo errore: ' + props.getProperty('cs_lastError'));
}

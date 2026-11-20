# Calendar Sync

Componente aggiuntivo di Google Calendar (Apps Script) che tiene allineati più calendari mostrando gli impegni come blocchi "Occupato" negli altri calendari, senza svelarne i dettagli.

- **Un senso o doppio senso:** scegli da quale calendario prendere gli impegni e su quali mostrarli, con l'opzione di sincronizzare anche al contrario.
- **Privacy:** di default i blocchi si chiamano "Occupato" e sono privati. Il nome vero degli impegni si mostra solo se lo attivi, e gli eventi privati restano sempre "Occupato".
- **Fuori sede:** viene copiato come vero evento "Fuori sede" sul calendario principale, con le impostazioni dell'originale.
- **Si aggiorna da solo:** cancellazioni, spostamenti ed eventi rifiutati nel calendario di origine si riflettono sugli altri.
- **Nessun server esterno:** tutto gira nel tuo account Google.

## File

| File | Contenuto |
|---|---|
| `Settings.gs` | Impostazioni salvate per ogni utente |
| `Sync.gs` | Motore di sincronizzazione |
| `Card.gs` | Scheda nel pannello laterale di Calendar |
| `appsscript.json` | Manifest: permessi e dati del componente aggiuntivo |

## Installazione (prova, senza pubblicare)

1. Vai su [script.google.com](https://script.google.com) con l'account su cui vuoi usarlo e crea un **nuovo progetto**.
2. Crea tre file di script con i nomi `Settings`, `Sync` e `Card` e incolla il contenuto dei file `.gs` corrispondenti. Elimina il file `Code.gs` iniziale.
3. Apri **Impostazioni progetto** (ingranaggio) e attiva **"Mostra il file manifest appsscript.json nell'editor"**. Apri `appsscript.json` e sostituisci tutto il contenuto con quello di questo repository.
4. Salva (Ctrl+S).
5. Clicca **Esegui il deployment > Testa i deployment**. Deve comparire "Componente aggiuntivo di Google Workspace". Clicca **Fine**.
6. Apri [Google Calendar](https://calendar.google.com) con lo stesso account e ricaricalo con Ctrl+Maiusc+R.
7. Nella barra laterale destra compare l'icona del componente aggiuntivo. Al primo clic ti chiede di autorizzare i permessi.

## Primo utilizzo

1. Se vuoi usare un calendario di un altro account, fattelo condividere con questo account e accettalo: deve comparire in "Altri calendari" di Google Calendar. Per il calendario di origine basta "Visualizza tutti i dettagli degli eventi"; per quelli che ricevono i blocchi serve "Apporta modifiche agli eventi".
2. Nel pannello scegli **Prendi gli impegni da**, poi **Mostrali su**, ed eventualmente **Sincronizza anche al contrario**.
3. Premi **Attiva**.
4. Con **Rimuovi tutti i blocchi** (sezione Opzioni) elimini tutto quello che ha creato lo script. Gli eventi originali non vengono mai toccati.

## Limiti da conoscere

- Il controllo automatico gira ogni ora. "Sincronizza ora" aggiorna subito.
- Gli eventi "Fuori sede" si possono creare solo su un calendario principale (il tuo o quello di un altro account condiviso con te): sui calendari secondari diventano blocchi "Occupato". Se nel calendario di destinazione c'è già un "Fuori sede" che copre lo stesso periodo, non viene aggiunto nessun blocco.
- Un calendario condiviso con te solo come "libero/occupato" può essere usato come **origine**: gli orari arrivano come "Occupato", senza nome né "Fuori sede". Non può ricevere blocchi, quindi con lui non è possibile il doppio senso.
- Gli eventi "tutto il giorno" non vengono copiati, salvo attivare l'opzione. Google li segna di default come "Libero" e l'opzione "Salta gli eventi segnati come Libero" li esclude.
- Nei domini Google Workspace l'amministratore può limitare Apps Script o l'accesso di app esterne a Calendar.

## Permessi richiesti

| Permesso | A cosa serve |
|---|---|
| `calendar.events` | Leggere gli eventi di origine e creare, aggiornare ed eliminare i blocchi |
| `calendar.calendarlist.readonly` | Mostrare l'elenco dei tuoi calendari e verificare i permessi |
| `calendar.freebusy` | Leggere gli orari occupati di un calendario condiviso solo come libero/occupato |
| `calendar.addons.execute` | Mostrare il pannello nella barra laterale di Calendar |
| `script.scriptapp` | Creare il controllo automatico periodico |
| `userinfo.email` | Identificare l'account in uso |

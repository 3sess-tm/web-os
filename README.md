# WebOS Starter

Ein Browser-Desktop mit:

- Desktop-Icons + Launcher + Taskbar
- verschiebbaren und skalierbaren Fenstern
- Apps aus `apps.json`
- `iframe`-basierter App-Isolation
- PostMessage IPC zwischen App und OS
- IndexedDB-Dateisystem (`mkdir`, `list`, `stat`, `writeFile`, `readFile`, `rm`, `cp`, `mv`)
- getrenntem Key/Value-Speicher
- periodischem App-Scheduler aus dem Meta-JSON
- Cross-App-Messaging

## Start

Browser brauchen für Module, `fetch()` und einige Sicherheitsfunktionen einen HTTP-Server.

Zum Beispiel:

```bash
cd browser_os
python3 -m http.server 8080
```

Dann `http://localhost:8080/` öffnen.

## App-API

Request an das Parent-OS:

```js
parent.postMessage({
  os: 'request',
  id: crypto.randomUUID(),
  type: 'fs',
  action: 'writeFile',
  args: { path: '/hello.txt', data: 'Hi' }
}, '*');
```

Antwort:

```js
{ os: 'response', id, ok: true, result: ... }
```

Cross-App:

```js
parent.postMessage({
  os: 'request',
  id: crypto.randomUUID(),
  type: 'ipc',
  to: 'notes',
  name: 'open-note',
  data: { path: '/hello.txt' }
}, '*');
```

## Sicherheitshinweis

Ein Browser-OS kann Daten zwar in IndexedDB verstecken und zusätzlich verschlüsseln, aber eine Web-App ist nicht geheim gegenüber dem Browser-Besitzer: DevTools können Netzwerk, JavaScript und Laufzeit beobachten. Der KV-Layer hier besitzt deshalb absichtlich keine sichtbare UI; für echte Geheimnisse sollte zusätzlich Web Crypto mit einem nicht im Quelltext hinterlegten Schlüssel eingesetzt werden.

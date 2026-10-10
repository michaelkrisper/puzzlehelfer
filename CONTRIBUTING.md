# Mitarbeiten

Fehlerberichte, Fotos mit Fehlerkennungen und Pull Requests sind willkommen.

## Einrichten

Voraussetzungen: Node.js 24, Google Chrome (für den Browsertest) und
Python 3 mit NumPy und Pillow (für die Testfotos aus `tools/synth.py`).

```sh
npm ci
npm run serve        # http://localhost:8793
```

Es gibt keinen Build-Schritt; die Dateien im Hauptverzeichnis sind die App,
die Bilderkennung liegt in `core/` und läuft im Browser wie in Node.

## Vor dem Pull Request

```sh
npm run lint:fix     # Biome: formatieren und linten
npm test             # Unit- und Erkennungstests (node:test)
npm run test:e2e     # Ende-zu-Ende im headless Chrome, lose und halbfertig
```

Die CI führt dieselben Schritte aus, dazu Ruff für `tools/*.py`.

## Hinweise

- Änderungen an App-Dateien: `VERSION` in `sw.js` hochzählen, sonst
  liefert der Service Worker weiter die alte Fassung aus.
- Änderungen an der Erkennung mit `tools/bench.mjs` über mehrere Szenen aus
  `tools/synth.py` messen, auch mit `--badref`, und die Zahlen vorher/nachher
  im Pull Request nennen. Entscheidend ist „sicher, davon richtig“: ein
  falscher sicherer Vorschlag wiegt schwerer als ein fehlender.
- Alle Pixelmaße sind auf rund 90 px Teilgröße abgestimmt; neue Schwellen
  bitte relativ dazu wählen.
- OpenCV.js: Speicheransichten (`mat.data`) erst nach allen Allokationen
  holen, wachsender WASM-Speicher macht ältere Ansichten ungültig.
- Keine Fotos fremder Urheber ins Repo.
- Commit-Nachrichten und Kommentare auf Deutsch, Code-Bezeichner auf Englisch.

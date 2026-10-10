# Änderungen

## 1.0.0 – 2026-10-10

- Vorlage vom Schachteldeckel: Bildrand automatisch gefunden und von Hand
  nachziehbar, Raster aus Teilezahl und Seitenverhältnis.
- Teile auf dem Tisch erkennen (Farbmodell des Tischs, Hysterese, GrabCut bei
  schlechter Form), Ecken und Seitenprofile (Nase, Loch, gerade).
- Platz und Drehung per Bildvergleich mit Farbangleich je Kandidat, robust
  gegen schlechte, unscharfe oder spiegelnde Vorlagen.
- Puzzle-Regeln: gerade Seiten nur am Rand und nach außen, Nasen- und
  Lochprofile der Nachbarn, Lösung wächst von außen nach innen.
- Halbfertiges Puzzle im Foto: belegte Plätze, Lückenumrisse, Pfeile direkt
  zum Platz.
- Mehrere Fotos je Runde, doppelt fotografierte Teile werden erkannt.
- Installierbar und offline, keine Daten verlassen das Gerät.
- Biome, Ruff, Unit- und Erkennungstests an künstlichen Szenen, Browsertest,
  CI mit Deploy auf GitHub Pages.

// Auswertung über mehrere Szenen aus tools/synth.py, eine Zeile je Szene.
// node tools/bench.mjs DIR... [--clean | --badref [--truth-quad]]
import { evaluate } from './eval.mjs';

const args = process.argv.slice(2);
const dirs = args.filter((a) => !a.startsWith('--'));
const sum = { loose: 0, detected: 0, cornerOk: 0, cellRotOk: 0, accepted: 0, acceptedOk: 0 };
for (const dir of dirs) {
  try {
    const { res: r } = await evaluate(dir, {
      clean: args.includes('--clean'),
      badref: args.includes('--badref'),
      truthQuad: args.includes('--truth-quad'),
    });
    for (const k of Object.keys(sum)) sum[k] += r[k];
    const b = r.board ? `${r.board.filled}/${r.board.truthFilled} falsch ${r.board.filledWrong}` : '-';
    console.log(
      `${dir.split('/').pop().padEnd(26)} ${r.grid.padEnd(6)} lose ${String(r.loose).padStart(4)}  erkannt ${String(r.detected).padStart(4)}  Ecken ${String(r.cornerOk).padStart(4)}  Platz+Dreh ${String(r.cellRotOk).padStart(4)}  sicher ${String(r.accepted).padStart(4)} davon richtig ${String(r.acceptedOk).padStart(4)}  Brett ${b}  ${((r.ms.ref + r.ms.scene + r.ms.solve) / 1000).toFixed(1)} s`,
    );
  } catch (err) {
    console.log(`${dir.split('/').pop().padEnd(26)} FEHLER ${String(err?.stack ?? err).slice(0, 300)}`);
  }
}
console.log('Summe', JSON.stringify(sum));
process.exit(0);

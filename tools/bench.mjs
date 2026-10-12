// Evaluation over several scenes from tools/synth.py, one line per scene.
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
    const b = r.board ? `${r.board.filled}/${r.board.truthFilled} wrong ${r.board.filledWrong}` : '-';
    console.log(
      `${dir.split('/').pop().padEnd(26)} ${r.grid.padEnd(6)} loose ${String(r.loose).padStart(4)}  detected ${String(r.detected).padStart(4)}  corners ${String(r.cornerOk).padStart(4)}  place+rot ${String(r.cellRotOk).padStart(4)}  sure ${String(r.accepted).padStart(4)} of which right ${String(r.acceptedOk).padStart(4)}  board ${b}  ${((r.ms.ref + r.ms.scene + r.ms.solve) / 1000).toFixed(1)} s`,
    );
  } catch (err) {
    console.log(`${dir.split('/').pop().padEnd(26)} ERROR ${String(err?.stack ?? err).slice(0, 300)}`);
  }
}
console.log('total', JSON.stringify(sum));
process.exit(0);

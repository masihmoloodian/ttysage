// A CLI TtySage has never seen: hand-rolled raw-mode rendering, inverse-video highlight, no glyphs.
const items = ['alpha cluster', 'beta cluster', 'gamma cluster'];
let i = 0;
const out = process.stdout;
const draw = (first) => {
  if (!first) out.write(`\x1b[${items.length + 1}A`);
  out.write('\x1b[2KWhich target should receive the sample config:\r\n');
  for (const [k, it] of items.entries()) out.write(`\x1b[2K${k === i ? '\x1b[7m' : ''}  ${it}\x1b[0m\r\n`);
};
out.write('\x1b[?25l');
draw(true);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (b) => {
  const s = b.toString();
  if (s === '\x1b[A' || s === '\x1bOA') i = (i + items.length - 1) % items.length;
  else if (s === '\x1b[B' || s === '\x1bOB') i = (i + 1) % items.length;
  else if (s === '\r') { out.write('\x1b[?25h'); process.stdin.setRawMode(false); process.stdin.pause(); askName(); return; }
  else if (s === '\x03') process.exit(130);
  draw(false);
});
function askName() {
  out.write(`selected: ${items[i]}\r\n`);
  out.write('Label for the config [sample]: ');
  process.stdin.setRawMode(false);
  process.stdin.resume();
  process.stdin.once('data', (d) => {
    const v = d.toString().trim() || 'sample';
    out.write(`RESULT ${JSON.stringify({ target: items[i], label: v })}\r\n`);
    process.exit(0);
  });
}

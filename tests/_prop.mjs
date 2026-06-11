// Shared property-test toolkit: the seeded RNG and document generators the
// convergence fuzzer judges with, importable by every law-based suite.
//
// The default generator paths are lifted verbatim from convergence.test.mjs
// and must keep consuming the RNG identically — existing fuzz seeds reproduce
// byte-identical documents. The `rich` flag adds the constructs the model
// layer must face (escapes, entities, del, underscore emphasis, soft breaks)
// and is opt-in precisely so it never perturbs those seeds.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
export const irange = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

export function genInline(rnd, rich) {
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'fox'];
  const bits = [];
  for (let i = 0, n = irange(rnd, 1, 4); i < n; i++) {
    const w = pick(rnd, words);
    const forms = [w, w, w, `**${w}**`, `*${w}*`, '`' + w + '`',
      `[${w}](https://x.test/${w})`, `![${w}](${w}.png)`];
    if (rich) {
      forms.push(`\\*${w}\\*`, `${w}&amp;${w}`, `~~${w}~~`, `_${w}_`, `__${w}__`);
    }
    bits.push(pick(rnd, forms));
  }
  return bits.join(' ');
}

export function genBlock(rnd, rich) {
  switch (irange(rnd, 1, 6)) {
    case 1: return '#'.repeat(irange(rnd, 1, 3)) + ' ' + genInline(rnd, rich);
    case 2:
      if (rich && rnd() < 0.3) return genInline(rnd, rich) + '\n' + genInline(rnd, rich);
      return genInline(rnd, rich);
    case 6: return '> ' + genInline(rnd, rich);
    default: {
      const ordered = rnd() < 0.3;
      const items = [];
      for (let i = 0, n = irange(rnd, 2, 5); i < n; i++) {
        const marker = ordered ? `${i + 1}. ` : '- ';
        const nest = rnd() < 0.3 && i > 0 ? '  ' : '';
        items.push(nest + (nest && ordered ? '1. ' : nest ? '- ' : marker) + genInline(rnd, rich));
      }
      return items.join('\n');
    }
  }
}

export function genDoc(rnd, rich) {
  const blocks = [];
  for (let i = 0, n = irange(rnd, 2, 4); i < n; i++) blocks.push(genBlock(rnd, rich));
  return blocks.join('\n\n') + '\n';
}

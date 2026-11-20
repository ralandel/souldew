// Hand-drawn ornaments for avatar frames, centred on their own box ('.' = transparent, '_' = erase what is below).
// Letters are tones mapped by the recipe: a = outline/darkest, b = dark, c = mid, d = light, e = highlight,
// f/g = a second material (stem, centre, setting). Every symmetric piece is drawn symmetric so it can sit exactly on
// the frame's centre line (orn widens/narrows it by one column to match the canvas parity – see fitWidth).
export const ART = {
  // ---- hardware
  rivet: ['.d.', 'dcb', '.b.'],
  rivet2: ['dc', 'cb'],
  screw: ['.cc.', 'cdab', 'cabb', '.bb.'],   // slotted screw head, slot at 45°
  led: ['ed', 'dc'],

  // ---- gems
  gem5: ['.aaa.', 'aedca', 'adcba', 'acbba', '.aaa.'],
  gem7: ['..aaa..', '.aedca.', 'aedccba', 'adccbba', '.acbba.', '..aba..', '...a...'],
  drop5: ['..a..', '.aea.', 'adcba', 'acbba', '.aaa.'],
  pearl: ['.cc.', 'cedb', 'cdbb', '.bb.'],
  cab6: ['.aaaa.', 'aeddca', 'adccba', 'acbbba', '.aaaa.'],   // oval cabochon

  // ---- sky
  star5: ['..c..', '..d..', 'cdedc', '..d..', '..c..'],
  star3: ['.c.', 'cdc', '.c.'],
  star7: ['...c...', '...d...', '..cdc..', 'cddeddc', '..cdc..', '...d...', '...c...'],
  moon7: ['..aaa..', '.add...', 'adc....', 'adc....', 'adc....', '.add...', '..aaa..'],
  moon9: ['...aaa...', '..adda...', '.adc.....', 'adc......', 'adc......', 'adc......', '.adc.....', '..adda...', '...aaa...'],
  comet: ['...cde', '.bcdd.', 'bc....'],

  // ---- plants
  leafR: ['....aa', '..accd', '.acdd.', 'acdc..', 'acc...', 'b.....'],
  leafL: ['aa....', 'dcca..', '.ddca.', '..cdca', '...cca', '.....b'],
  leaf5: ['..aa.', '.acda', 'acdca', 'acca.', 'ba...'],
  sprig: ['.a.a.', 'acaca', '.aba.', '..b..', '..b..'],
  blossom: ['..c.c..', 'c.cdc.c', 'ccdedcc', '.cdedc.', '.ccdcc.', 'cdc.cdc', '.c...c.'],
  bloom5: ['.c.c.', 'cdcdc', '.cec.', 'cdcdc', '.c.c.'],
  bud: ['.c.', 'cdc', '.b.'],
  petal: ['cd', 'dc'],
  petal1: ['d'],
  berry: ['.a.', 'aea', 'aaa'],
  maple: ['...a...', '.a.a.a.', '.aacaa.', 'aaacaaa', '.aacaa.', '..aca..', '...b...'],
  acorn: ['.bbb.', 'bdccb', '.aaa.', '.acc.', '..a..'],
  mush: ['.ccc.', 'cdedc', 'ccccc', '..b..', '.bbb.'],
  wheat: ['..c..', '.c.c.', '..c..', '.c.c.', '..c..', '.cbc.', '..b..', '..b..'],

  // ---- weather / water
  drop: ['.d', 'dc', 'cc'],
  rain: ['d', 'c'],
  flake5: ['c.c.c', '.cdc.', 'cdedc', '.cdc.', 'c.c.c'],
  flake7: ['...c...', '.c.c.c.', '..cdc..', 'ccdedcc', '..cdc..', '.c.c.c.', '...c...'],
  bolt: ['..dd', '.dd.', 'dddd', '..d.', '.d..'],
  cloud: ['...cdd...', '.ccdddd..', 'cccddddd.', 'bccccccdc', '.bbbbbbb.'],
  bubble: ['.d.', 'd.c', '.c.'],
  bubble2: ['.dc.', 'd..c', 'c..b', '.bb.'],
  shell: ['...a...', '..aea..', '.adcda.', 'adcdcda', 'acdcdca', '.abbba.'],
  wave: ['..dd..', '.dccd.', 'dc..cd'],

  // ---- fire
  ember: ['d'],
  ember2: ['e', 'd'],

  // ---- craft
  crane: ['....a....', '...ada...', 'a.adcda.a', 'aadcccdaa', '.adcccda.', '..abcba..', '...aba...'],
  knot: ['.ab.ba.', 'acdadca', 'bdcacdb', '.acdca.', 'bdcacdb', 'acdadca', '.ab.ba.'],
  bow: ['a.....a', 'cda.adc', 'cdcecdc', 'cda.adc', 'a.b.b.a', '..b.b..'],
  stitch: ['c'],
  button: ['.aaa.', 'acdca', 'adbda', 'acdca', '.aaa.'],
  pin: ['.ee', 'ed.', 'd..'],
  lantern: ['..a..', '.aaa.', 'adeda', 'adeda', 'acdca', '.aaa.', '..a..'],
  moth: ['aa.aa', 'dcacd', '.dad.', 'dc.cd'],
  feather: ['....dd', '..ddc.', '.dcc..', 'dcc...', 'b.....'],
  key: ['.aaa.', 'a.d.a', '.aaa.'],

  // ---- our own brand: the app mark (release-300/web/lib/icons.mjs AppMark – two pixel rings linked by a bar, the
  //      SoulLink idea – halved to its native 14×6 grid). a = left ring, b = right ring, c = the link bar.
  mark: ['.aaa......bbb.', 'a...a....b...b', 'a....cccc....b', 'a....cccc....b', 'a...a....b...b', '.aaa......bbb.'],
};

// The "souldew" wordmark, condensed from the app's pixel face (Pixelify Sans) to 7 rows: 2 ascender + 5 x-height.
const GLYPH = {
  s: ['...', '...', '.##', '#..', '.#.', '..#', '##.'],
  o: ['....', '....', '.##.', '#..#', '#..#', '#..#', '.##.'],
  u: ['...', '...', '#.#', '#.#', '#.#', '#.#', '.##'],
  l: ['#', '#', '#', '#', '#', '#', '#'],
  d: ['..#', '..#', '.##', '#.#', '#.#', '#.#', '.##'],
  e: ['...', '...', '.#.', '#.#', '###', '#..', '.##'],
  w: ['.....', '.....', '#...#', '#...#', '#.#.#', '#.#.#', '.#.#.'],
};
export function word(text, ch = 'w') {
  const rows = Array.from({ length: 7 }, () => '');
  [...text].forEach((c, i) => { const g = GLYPH[c]; for (let y = 0; y < 7; y++) rows[y] += (i ? '.' : '') + g[y].replace(/#/g, ch); });
  return rows;
}
ART.wordmark = word('souldew');


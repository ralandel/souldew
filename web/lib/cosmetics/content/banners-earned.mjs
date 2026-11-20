// The banners you EARN instead of buy – free for everyone who has the trophy, never sold, so they ship with the app (next
// to the free Basics), not in the pack: the trophy is the key, not the membership. Earned on this computer (the trophies
// are computed locally – web/lib/trophies.mjs), like the trophy cabinet that shows the same trophies.
// shared/handheld.mjs UNLOCKS lists them with the handheld's earned stickers.
export default [
  {
    id: 'summit-dawn', name: 'Summit Dawn', set: 'earned', rarity: 'earned', trophy: 'hardcoreWin', seed: 907, loop: 24, plate: { x: 250, y: 10 },
    pal: { s0: '#1c2448', s1: '#4a3f6e', s2: '#b0687a', s3: '#f0b48a', sun: '#fff3d6', glow: '#f6cfa0', far: '#6a5a86', farS: '#4e4570',
      snowS: '#e8cfd6', rock: '#262443', rockL: '#463f66', cloud: '#f7dcc8', cloud2: '#d9a6a6', flag: '#d0443a', pole: '#14122a' },
    intro: { reveal: 'rise' },
    layers: [
      ['sky', { bands: [['s0', 12], ['s1', 22], ['s2', 32], ['s3', 56]], seam: 5 }],
      ['glow', { x: 306, y: 36, rings: [['glow', 40, 0.7]], ry: 0.5, only: ['s2', 's3'] }],
      ['sun', { x: 306, y: 35, r: 5, c: 'sun' }],
      ['stars', { y: [0, 10], density: 3, c: ['s1', 's1', 'sun'], twinkle: 0.3 }],
      ['ridge', { id: 'far', style: 'alps', base: 41, amp: 12, spacing: 46, c: 'far', snow: { c: 'snowS', line: 32, depth: 4 }, shade: { c: 'farS', side: -1, depth: 30, slant: 0.6 }, depth: 0.1 }],
      ['clouds', { style: 'strata', at: [[110, 39, 90, 3], [340, 41, 80, 3], [214, 43, 60, 2]], c: ['cloud', 'cloud2', 's3'], drift: 0.6, depth: 0.15 }],
      ['ridge', { id: 'peak', style: 'points', points: [[-400, 62], [140, 54], [200, 40], [236, 24], [250, 13], [262, 21], [300, 35], [360, 49], [800, 60]], jitter: 1.2, c: 'rock', rim: { c: 'rockL', side: -1, w: 2 }, depth: 0.4 }],
      ['sprite', { art: ['ab..', 'abbb', 'abb.', 'a...', 'a...'], x: 250, on: 'peak', sink: 0, map: { a: 'pole', b: 'flag' }, depth: 0.4 }],
    ],
  },
];

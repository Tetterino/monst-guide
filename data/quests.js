// 難易度・クエスト・ステージの定義
// ステージの座標・半径はキャンバス(420x468)上のピクセル。フィールド内側は x:24〜396 / y:24〜444（ゲーム画面の比率）
//   type: 'enemy' = 本より先に触れておく敵, 'book' = 最後に殴る本
//   on:   初期状態で配置するか（画面上で ON/OFF を切り替えられる）
// rules: ステージで練習する「狙い」。kind ごとの成功条件は assets/route-sim.js を参照
//   off:  その狙いを選んだときに OFF にする敵（すでに処理済みのもの）
window.DIFFICULTIES = [
  { id: 'metsuzetsu', name: '滅絶' },
];

window.QUESTS = [
  {
    id: 'philosophia',
    name: 'フィロソフィア',
    difficulty: 'metsuzetsu',
    description: 'ダメージリンクのルート探し',
    stageCount: 8,
    stages: {
      // ゲーム画面のスクショから換算。中ボスはフィールド中心 (210,234)、他は中ボスを中心に点対称
      // 本は中ボスと重なっている
      4: {
        note: '目玉 → 本で目玉を処理した後、中ボス → 壁4面 → 本で中ボスを削る',
        rules: [
          { id: 'eyes', label: '目玉処理: 目玉すべて → 本', kind: 'linkAll' },
          {
            id: 'boss',
            label: '中ボス削り: 中ボス → 上下左右の壁 → 本',
            kind: 'targetWallsBook',
            target: 'mid',
            off: ['eye-tl', 'eye-tr', 'eye-bl', 'eye-br'],
          },
        ],
        ball: { x: 174, y: 137 },
        objects: [
          { id: 'eye-tl', label: '目玉左上', type: 'enemy', x: 55,  y: 56,  r: 20, on: true },
          { id: 'eye-tr', label: '目玉右上', type: 'enemy', x: 271, y: 143, r: 20, on: true },
          { id: 'eye-bl', label: '目玉左下', type: 'enemy', x: 149, y: 325, r: 20, on: true },
          { id: 'eye-br', label: '目玉右下', type: 'enemy', x: 365, y: 412, r: 20, on: true },
          { id: 'mid',    label: '中ボス',   type: 'enemy', x: 210, y: 234, r: 72, on: true },
          { id: 'book-l', label: '本左',     type: 'book',  x: 146, y: 176, r: 30, on: true },
          { id: 'book-r', label: '本右',     type: 'book',  x: 274, y: 292, r: 30, on: true },
        ],
      },
    },
  },
];

window.findQuest = id => window.QUESTS.find(q => q.id === id);
window.findDifficulty = id => window.DIFFICULTIES.find(d => d.id === id);

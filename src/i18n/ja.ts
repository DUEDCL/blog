/**
 * 日本語の文言。
 *
 * 文体の決め：**常体（だ・である）を基本**にする。彼の書き方が短く断定的で、
 * 世辞を言わないからで、ですます体に直すと語気が丸くなって別人になる。
 * 例外は**訪問者に直接話しかけるところ**（AI 分身の挨拶、入力欄の案内）——
 * そこだけ「です」体にする。日本語ではそれが自然な語域の切り替えだ。
 *
 * 三条底线は `en.ts` と同じ：語気は彼に合わせる・できない約束はしない・
 * 刊名（「沉麟」の二文字）は訳さない。
 */
import type { Strings } from './types';

export const ja: Strings = {
  siteDescription: '沉麟の個人サイト —— 技術記事、随筆、写真、作品。',

  bio: [
    '自分と友達になろうとしている、ただそれだけの人間だ。',
    'ここには作ったものと、それを正しくするまでの過程を置いてある。',
  ],

  /* 「图库」に当たるのは `ギャラリー`。中国語の方では顶栏（ナビ）と栏目（見出し）で
     わざと違う語を使っている（ナビは案内で見出しではない）ので、そこは踏襲した。
     狭い画面のナビは 3 列グリッドで一項 76px ほど —— カタカナ 5 文字で収まる */
  nav: {
    home: 'ホーム',
    posts: '記事',
    notes: '随筆',
    projects: '作品',
    music: '音楽',
    photos: 'ギャラリー',
    about: '名刺',
  },

  sections: {
    posts: {
      label: '記事',
      title: '技術記事',
      description: '詰まったところの記録、実装のメモ、それとようやく分かったこと。',
      note: 'ゆっくり読めばいい。読み終えるより分かるほうが大事だ。',
      empty: 'まだ記事がない。src/content/posts/ に .md を置けばいい。',
    },
    notes: {
      label: '随筆',
      title: '随筆',
      description: '体系立っていない観察、読んだもの、それと少し私的な考え。',
      note: '気ままに眺めればいい。まとまっていなくてかまわない。',
      empty: 'まだ随筆がない。src/content/notes/ に .md を置けばいい。',
    },
    photos: {
      label: '写真',
      title: '写真',
      description: '組ごとにまとめた写真。',
      note: 'ゆっくり見ればいい。光と影が自分で語る。',
      empty: '写真はまだ整理できていない。一組そろってから置く。',
    },
    projects: {
      label: '作品',
      title: '作品',
      description: '作ってきたもののいくつか。',
      note: 'これで全部だ。ひとつ選んでみて。',
      empty: 'まだ作品がない。src/content/projects/ に .md を置けばいい。',
    },
  },

  portals: {
    archive: { label: 'アーカイブ', description: 'サイト全体を年ごとに一本の時間軸へ並べたもの。' },
    tags: { label: 'タグ', description: '主題で横に辿る。何を一番多く書いているかが見える。' },
    photos: { label: 'ギャラリー', description: '組ごとにまとめた写真。一組で一ページ。' },
    portal: { label: '入口', description: '入る前のあの扉へ戻る。いつでももう一度見られる。' },
  },

  editions: {
    night: { name: '夜刊', note: '深夜の印刷所で刷り上がったばかりの版' },
    paper: { name: '朝刊', note: '朝いちばんに戸口へ届く新聞紙' },
    film: { name: 'フィルム', note: '期限切れのロールから出てくる暖かい褐色' },
    neon: { name: 'ネオン', note: '黒い紙に刷った蛍光インク' },
  },

  common: {
    skipToMain: '本文へ移動',
    mainNav: 'メインナビゲーション',
    brandCard: (site) => `${site} の名刺`,
    brandHome: (site) => `${site} のホーム`,
    avatarAlt: (site) => `${site} の顔写真`,
    editionKey: '版',
    editionMenu: '版を選ぶ',
    langKey: '言語',
    langMenu: '言語を選ぶ',
    langNames: { zh: '简体中文', en: 'English', ja: '日本語' },
    close: '閉じる',
    footArchive: 'アーカイブ',
    footTags: 'タグ',
    footPortal: '入口',
    email: 'メール',
    weibo: 'Weibo',
    zhihu: 'Zhihu',
  },

  home: {
    issue: (n) => `第 ${n} 号`,
    allCount: (n) => `全 ${n} 件 →`,
    all: 'すべて →',
    elsewhere: 'ほかの場所',
  },

  list: {
    count: (n) => `全 ${n} 件`,
  },

  article: {
    updated: (date) => `${date} 更新`,
    backTo: (section) => `← ${section}へ戻る`,
    onlyInChinese: 'これは中国語の原文しかない。以下がその原文だ。',
  },

  archive: {
    title: 'アーカイブ',
    description: 'このサイトにあるもの全部の時間軸。年ごとにまとめてある。',
    lead: '記事・随筆・作品を一本の時間軸にまとめたもの。',
    searchPlaceholder: 'タイトルを検索',
    hit: (n, total) => `${n} / ${total} 件`,
    miss: (q) => `「${q}」に一致するタイトルはない`,
    empty: 'まだ何もない。',
    count: (n) => `全 ${n} 件`,
  },

  tags: {
    title: 'タグ',
    description: 'このサイトのタグ全部と、それぞれの下にあるもの。',
    lead: '記事・随筆・作品でタグは共通だ。',
    count: (n) => `全 ${n} 個`,
    entryCount: (n) => `${n} 件`,
    empty: 'まだタグがない。記事の frontmatter に tags を足せばここに出る。',
  },

  notFound: {
    title: 'ページが見つからない',
    description: 'このページは存在しない。',
    label: '訂正',
    heading: 'ここには何もない',
    hint: 'アドレスの綴りが違うか、この記事はもう消してある。',
    ways: 'どこへ戻る',
  },

  projects: {
    status: { active: '使用中', wip: '進行中', archived: 'アーカイブ' },
    live: '公開 ↗',
    repo: 'ソース ↗',
    count: (n) => `全 ${n} 件`,
  },

  photos: {
    count: (n) => `全 ${n} 組`,
    shots: (n) => `${n} 枚`,
    zoom: '拡大',
    lightbox: (album) => `${album} の大きい画像`,
    prev: '前の写真',
    next: '次の写真',
  },

  about: {
    title: '名刺',
    description: (site) => `${site} への連絡先`,
    label: '名刺',
    elsewhere: 'ほかの場所',
    empty: '連絡先はまだ整理できていない。',
    zoom: 'タップで拡大',
    copied: 'コピーした',
    copyFallback: 'コピー',
    qrOf: (label) => `${label} の QR コード`,
    zoomQrOf: (label) => `${label} の QR コードを拡大`,
    contacts: {
      wechat: {
        label: 'WeChat',
        copy: 'ニックネームをコピー',
        note: 'WeChat には友だち追加のリンクがない。コードを読むのが唯一確実な方法だ。タップして拡大し、画面のこれをスマホで読めばいい。',
      },
      qq: {
        label: 'QQ',
        /* 「友だち追加」とは書かない —— これは本体アプリを**呼び出そうとする**だけで、
           入っていなければ何も起きない */
        action: 'QQ で開く',
        copy: '番号をコピー',
        note: 'ウェブから一時会話を始めることはもうできない。友だち追加しかない。番号をコピーして QQ の中で探すのが一番確実。QQ が入っていれば上のキーで直接飛べる。',
      },
      douyin: {
        label: '抖音',
        action: 'プロフィールを開く',
        copy: '抖音 ID をコピー',
        note: '抖音には友だち追加のリンクがない。コードを拡大してアプリで読むか、ID をコピーして探す。',
      },
      telegram: {
        label: 'Telegram',
        action: 'チャットを開く',
        copy: 'ユーザー名をコピー',
        note: 'タップすればそのままチャットになる。友だち追加は要らない。コードを読むか、ユーザー名をコピーして探してもいい。',
      },
      discord: {
        label: 'Discord',
        copy: 'ユーザー名をコピー',
        note: 'クライアントの中でユーザー名を検索して追加するしかない。押せるリンクはない。',
      },
      email: {
        label: 'メール',
        action: 'メールを書く',
        copy: 'アドレスをコピー',
        note: '一番遅くて一番確実。アプリに依存しないし、全部読んでいる。',
      },
    },
  },

  music: {
    title: 'レコードプレーヤー',
    description: 'いま聴いているもの —— 自分で書いたプレーヤーで、歌詞が一緒に流れる。',
    note: '音楽でもかけて、時間をゆっくりにしよう。',
    heading: 'レコードプレーヤー',
    deck: 'プレーヤー',
    lyrics: '歌詞',
    tracklist: '曲目',
    prev: '前の曲',
    next: '次の曲',
    play: '再生',
    pause: '一時停止',
    progress: '再生位置',
    volume: '音量',
    modeLabel: (mode) => `再生方式：${mode}`,
    modes: ['順番に再生', '全曲繰り返し', '一曲繰り返し', 'シャッフル'],
    juke: {
      heading: 'リクエスト',
      lead: 'プレイリストを選ぶか、曲名かアーティストで検索してください。一曲タップすると上の曲目に加わり、続けて流れます。「全部再生」はまとめてキューに入れて一曲目から流します。',
      searchPlaceholder: '曲名かアーティストを検索',
      searchLabel: '曲を検索',
      searchGo: '検索',
      idle: 'プレイリストを選ぶか、検索してみてください。',
      playAll: '全部再生',
      playAllLabel: 'すべてキューに入れて再生',
      needKeyword: '何を検索する？',
      loading: (what) => `${what}を取得中…`,
      none: (what) => `${what}：一曲もなかった。`,
      found: (what, n) =>
        `${what}：${n} 曲。一曲タップでキューに入る、または全部再生。`,
      offline: 'ネットが通っていない。あとでもう一度',
      unavailable: 'この曲はいま取れない。別のを',
      partial: '上流にはこの曲の一部しかない。流せるところまで流す',
      fetching: (title) => `「${title}」を取得中…`,
      quoted: (kw) => `「${kw}」`,
      charts: { mine: '沉麟のおすすめ', hot: 'ヒットチャート', original: 'オリジナル' },
      chartFallback: 'プレイリスト',
      requested: 'リクエスト',
      failed: '取れなかった',
    },
    lyricsLoading: '（歌詞を取得中…）',
    lyricsNone: '（この曲に歌詞はない）',
  },

  player: {
    collapse: 'プレーヤーをたたむ',
    expand: 'プレーヤーを開く',
    openDeck: 'レコードプレーヤーを開く',
    prev: '前の曲',
    next: '次の曲',
    play: '再生',
    pause: '一時停止',
    progress: '再生位置',
    volume: '音量',
  },

  /* 分身は訪問者に直接話しかけるので、ここだけ「です」体（冒頭の注記どおり） */
  chat: {
    hintTitle: '沉麟の分身',
    hintDesc: '私のこと、このサイト、いま作っているもの —— これに聞いてください。',
    hintClose: 'もう出さない',
    key: '沉麟の分身に聞く',
    keyShut: 'たたむ',
    who: '沉麟の分身',
    tipsHead: 'こんなふうに聞けます',
    placeholder: 'Enter で送信',
    inputLabel: '何を聞きますか',
    send: '送信',
    errGeneric: 'いまはうまく答えられません。少ししてからまた聞いてください',
    errEmpty: 'これには答えられません。',
    errNetwork: '接続が切れました。少ししてからまた聞いてください',
    /* 中国語版と同じ口径：**挨拶だけ、プライバシーの告知は入れない**（決議は zh.ts の注記） */
    opening: 'こんにちは、沉麟です。何を話しましょうか',
    starters: [
      'ふだん何をしていますか？',
      'このサイトは何で作られていますか？',
      '最近は何を学んでいますか？',
    ],
  },

  portal: {
    title: (site) => `${site} · 入口`,
    description:
      '細部にこだわり、「まあいい」が我慢できない。ここには作ったものと、それを正しくするまでの過程を置いてある。',
    enter: (site) => `${site} のサイトに入る`,
  },

  authorName: '沉麟',

  date: {
    long: (y, m, d) => `${y}年${m}月${d}日`,
    short: (y, m, d) => `${y}.${String(m).padStart(2, '0')}.${String(d).padStart(2, '0')}`,
  },

  /* キーは中国語の原文。`Astro` / `Python` / `SQLite` のような技術名は表に入れない ——
     引けなければそのまま出す */
  tagNames: {
    架构: 'アーキテクチャ',
    前端: 'フロントエンド',
    建站: 'サイト構築',
    数据分析: 'データ分析',
    语音: '音声',
    全文检索: '全文検索',
    二次开发: '二次開発',
    安全: 'セキュリティ',
    方法论: '方法論',
    测试: 'テスト',
    算法: 'アルゴリズム',
    笔记: 'メモ',
    随想: '随想',
    随笔: '随筆',
    思考: '思考',
  },

  rssLanguage: 'ja',
};

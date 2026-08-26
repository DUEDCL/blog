/**
 * English strings.
 *
 * 译法上的三条底线，与 `zh.ts` 里那些注释是同一套决议：
 * ① **语气跟着他**：句子短、直说结论、不客套、不加「Welcome to my blog」这类话。
 * ② **不许下做不到的承诺** —— 名片那六条尤其（QQ 那颗键只是尝试唤起本机 APP）。
 * ③ **刊名不译**：`SITE_TITLE` 三种语言下都是「沉麟」那两个字，句子里提到他时
 *    用 `authorName`（这一份是 `Chenlin`）。
 */
import type { Strings } from './types';

/** `date.long` 用。缩写月名太像收据，长月名才是刊物的写法 */
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** 英文要区分单复数，而「1 entry / 2 entries」这件事只在这一份词条里发生 */
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const en: Strings = {
  siteDescription:
    "Chenlin's personal site — technical writing, notes, photography and work.",

  bio: [
    "I'm just someone trying to make friends with myself.",
    "This is where I keep the things I've made, and how I got them right.",
  ],

  /* 窄屏顶栏是 `repeat(3, 1fr)` 的格子，每项必须短 —— 「Photography」塞不下，
     所以图库那项用 `Gallery`，与中文那份「图库不叫摄影」的取舍一致 */
  nav: {
    home: 'Home',
    posts: 'Posts',
    notes: 'Notes',
    projects: 'Work',
    music: 'Music',
    photos: 'Gallery',
    about: 'Contact',
  },

  sections: {
    posts: {
      label: 'Posts',
      title: 'Technical Writing',
      description: 'Things I broke, notes on how I built them, and a few things I finally understood.',
      note: 'Read it slowly. Understanding beats finishing.',
      empty: 'No posts yet. Add a .md file under src/content/posts/.',
    },
    notes: {
      label: 'Notes',
      title: 'Notes',
      description: 'Unsystematic observations, things I read, and a few private thoughts.',
      note: 'Just browse. It does not have to add up.',
      empty: 'No notes yet. Add a .md file under src/content/notes/.',
    },
    photos: {
      label: 'Photos',
      title: 'Photography',
      description: 'Photographs, kept in sets.',
      note: 'Take your time. Light and shadow speak for themselves.',
      empty: 'The photographs are not sorted yet. They go up once a set is finished.',
    },
    projects: {
      label: 'Work',
      title: 'Work',
      description: 'Some of the things I have built.',
      note: 'This is all of it. Pick one.',
      empty: 'No work yet. Add a .md file under src/content/projects/.',
    },
  },

  portals: {
    archive: { label: 'Archive', description: 'Everything on the site, laid out year by year.' },
    tags: { label: 'Tags', description: 'Read sideways by subject; see what I write about most.' },
    photos: { label: 'Gallery', description: 'Photographs kept in sets, one page per set.' },
    portal: { label: 'Entrance', description: 'Back to the door you came through. Look again any time.' },
  },

  editions: {
    night: { name: 'Night', note: 'Straight off the press at midnight' },
    paper: { name: 'Morning', note: 'Newsprint left at the door at dawn' },
    film: { name: 'Film', note: 'The warm brown of an expired roll' },
    neon: { name: 'Neon', note: 'Fluorescent ink on black paper' },
  },

  common: {
    skipToMain: 'Skip to main content',
    mainNav: 'Main navigation',
    brandCard: (site) => `${site} — contact card`,
    brandHome: (site) => `${site} — home`,
    avatarAlt: (site) => `Portrait of ${site}`,
    editionKey: 'Edition',
    editionMenu: 'Choose an edition',
    langKey: 'Language',
    langMenu: 'Choose a language',
    langNames: { zh: '简体中文', en: 'English', ja: '日本語' },
    close: 'Close',
    footArchive: 'Archive',
    footTags: 'Tags',
    footPortal: 'Entrance',
    email: 'Email',
    weibo: 'Weibo',
    zhihu: 'Zhihu',
  },

  home: {
    issue: (n) => `No. ${n}`,
    allCount: (n) => `All ${n} →`,
    all: 'All →',
    elsewhere: 'Elsewhere',
  },

  list: {
    count: (n) => plural(n, 'entry', 'entries'),
  },

  article: {
    updated: (date) => `Updated ${date}`,
    backTo: (section) => `← Back to ${section}`,
    /* 这一条只在「元数据译了、正文还是中文」时出现。措辞不含歉意 ——
       它陈述事实，不为一篇没译的文章道歉 */
    onlyInChinese: 'Only the Chinese original exists for this one. The text below is that original.',
  },

  archive: {
    title: 'Archive',
    description: 'A timeline of everything on this site, grouped by year.',
    lead: 'Posts, notes and work on one timeline.',
    searchPlaceholder: 'Search titles',
    hit: (n, total) => `${n} of ${total}`,
    miss: (q) => `No title matches “${q}”`,
    empty: 'Nothing here yet.',
    count: (n) => plural(n, 'entry', 'entries'),
  },

  tags: {
    title: 'Tags',
    description: 'Every tag on the site, and what sits under each one.',
    lead: 'Posts, notes and work share one set of tags.',
    count: (n) => plural(n, 'tag', 'tags'),
    entryCount: (n) => plural(n, 'entry', 'entries'),
    empty: 'No tags yet. Add tags to a post’s frontmatter and they show up here.',
  },

  notFound: {
    title: 'Page not found',
    description: 'This page does not exist.',
    label: 'Correction',
    heading: 'Nothing here',
    hint: 'The address may be misspelt, or I have deleted this one.',
    ways: 'Where to go',
  },

  projects: {
    status: { active: 'In use', wip: 'In progress', archived: 'Archived' },
    live: 'Live ↗',
    repo: 'Source ↗',
    count: (n) => plural(n, 'project', 'projects'),
  },

  photos: {
    count: (n) => plural(n, 'set', 'sets'),
    shots: (n) => plural(n, 'shot', 'shots'),
    zoom: 'Zoom',
    lightbox: (album) => `${album} — full size`,
    prev: 'Previous',
    next: 'Next',
  },

  about: {
    title: 'Contact',
    description: (site) => `Get in touch with ${site}`,
    label: 'Card',
    elsewhere: 'Elsewhere',
    empty: 'Contact details are not sorted out yet.',
    zoom: 'Tap to enlarge',
    copied: 'Copied',
    copyFallback: 'Copy',
    qrOf: (label) => `${label} QR code`,
    zoomQrOf: (label) => `Enlarge the ${label} QR code`,
    contacts: {
      wechat: {
        label: 'WeChat',
        copy: 'Copy nickname',
        note: 'WeChat has no add-friend link, so scanning is the only reliable way. Tap the code to enlarge it and scan it straight off the screen.',
      },
      qq: {
        label: 'QQ',
        /* 不写 'Add friend'：它只是**尝试**唤起本机 QQ，装了才有反应 */
        action: 'Open in QQ',
        copy: 'Copy number',
        note: 'Tencent no longer lets a web page start a chat, so it has to be a friend request. Copying the number and searching inside QQ is the surest route; with QQ installed, the key above can jump straight there.',
      },
      douyin: {
        label: 'Douyin',
        action: 'Open profile',
        copy: 'Copy Douyin ID',
        note: 'Douyin has no add-friend link: enlarge the code and scan it in the app, or copy the ID and search for it.',
      },
      telegram: {
        label: 'Telegram',
        action: 'Open chat',
        copy: 'Copy username',
        note: 'Tap it and you are in the chat — no friend request first. You can also scan the code or copy the username.',
      },
      discord: {
        label: 'Discord',
        copy: 'Copy username',
        note: 'Only searchable by username inside the client. There is no link to click.',
      },
      email: {
        label: 'Email',
        action: 'Write',
        copy: 'Copy address',
        note: 'The slowest and the surest. No app needed, and I read all of it.',
      },
    },
  },

  music: {
    title: 'Turntable',
    description: "What I'm listening to — a player I wrote myself, words scrolling along.",
    note: 'Put some music on. Let time slow down.',
    heading: 'Turntable',
    deck: 'Player',
    lyrics: 'Words',
    tracklist: 'Tracks',
    prev: 'Previous track',
    next: 'Next track',
    play: 'Play',
    pause: 'Pause',
    progress: 'Playback progress',
    volume: 'Volume',
    modeLabel: (mode) => `Playback mode: ${mode}`,
    modes: ['In order', 'Repeat all', 'Repeat one', 'Shuffle'],
    juke: {
      heading: 'Requests',
      lead: 'Pick a chart, or search by title or artist. Tap a song and it joins the tracklist above, playing next; “Play all” queues the whole batch from the first track.',
      searchPlaceholder: 'Search title or artist',
      searchLabel: 'Search for songs',
      searchGo: 'Go',
      idle: 'Pick a chart, or run a search.',
      playAll: 'Play all',
      playAllLabel: 'Queue everything and play',
      needKeyword: 'Search for what?',
      loading: (what) => `Fetching ${what}…`,
      none: (what) => `${what}: nothing came back.`,
      found: (what, n) =>
        `${what}: ${n} tracks. Tap one to queue it, or play them all.`,
      offline: 'No connection. Try again in a moment',
      unavailable: 'This one is unavailable right now. Try another',
      partial: 'Upstream only has a clip of this one — it plays as far as it goes',
      fetching: (title) => `Fetching “${title}”…`,
      quoted: (kw) => `“${kw}”`,
      /* 「沉麟推荐」用 authorName 那一份写法（Chenlin），与站上别处提到他时一致 */
      charts: { mine: 'Chenlin’s picks', hot: 'Hot songs', original: 'Original' },
      chartFallback: 'chart',
      requested: 'requested',
      failed: 'Nothing came back',
    },
    lyricsLoading: '(fetching the words…)',
    lyricsNone: '(no words for this one)',
  },

  player: {
    collapse: 'Collapse the player',
    expand: 'Expand the player',
    openDeck: 'Open the turntable',
    prev: 'Previous track',
    next: 'Next track',
    play: 'Play',
    pause: 'Pause',
    progress: 'Playback progress',
    volume: 'Volume',
  },

  chat: {
    hintTitle: "Chenlin's double",
    hintDesc: 'About me, this site, the things I am building — ask it.',
    hintClose: 'Dismiss',
    key: "Ask Chenlin's double",
    keyShut: 'Close',
    who: "Chenlin's double",
    tipsHead: 'You could ask',
    placeholder: 'Enter to send',
    inputLabel: 'What do you want to ask?',
    send: 'Send',
    errGeneric: "I can't answer that right now. Try again in a bit",
    errEmpty: "I can't answer that one.",
    errNetwork: 'The connection dropped. Try again in a bit',
    /* 与中文那句同一个口径：**纯问候，不含隐私告知**（决议见 zh.ts 那条注释） */
    opening: "Hi, I'm Chenlin. What do you want to talk about?",
    /* 英文这三条不必逐字对上知识库文件里的中文 question ——
       知识库只有中文，模型读中文、答英文（系统提示词里那条语言指令管这件事） */
    starters: [
      'What do you do?',
      'What is this site built with?',
      'What are you learning lately?',
    ],
  },

  portal: {
    title: (site) => `${site} · Entrance`,
    description:
      "Picky about details, no patience for “near enough”. This is where I keep the things I've made, and how I got them right.",
    enter: (site) => `Enter ${site}`,
  },

  authorName: 'Chenlin',

  date: {
    long: (y, m, d) => `${MONTHS[m - 1]} ${d}, ${y}`,
    short: (y, m, d) => `${y}.${String(m).padStart(2, '0')}.${String(d).padStart(2, '0')}`,
  },

  /* 键是中文原文。`Astro` / `Python` / `SQLite` / `Cloudflare Workers` 那些不进表 ——
     查不到就原样显示，技术名本来三种语言下都一样 */
  tagNames: {
    架构: 'Architecture',
    前端: 'Frontend',
    建站: 'Site building',
    数据分析: 'Data analysis',
    语音: 'Voice',
    全文检索: 'Full-text search',
    二次开发: 'Extending',
    安全: 'Security',
    方法论: 'Method',
    测试: 'Testing',
    算法: 'Algorithms',
    笔记: 'Notes',
    随想: 'Musings',
    随笔: 'Essays',
    思考: 'Thinking',
  },

  rssLanguage: 'en',
};

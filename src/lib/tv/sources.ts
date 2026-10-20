/**
 * 影视聚合 —— 点播源清单。
 *
 * 全部是公开的「苹果CMS V10 / MacCMS」兼容 JSON 接口：
 *   list   GET {api}?ac=videolist&wd=<关键词>&pg=<页>  → { code, page, pagecount, list[] }
 *   detail GET {api}?ac=detail&ids=<vod_id>            → { list[0].vod_play_from / vod_play_url }
 *
 * 2026-10 在本机逐个实测：HTTP 200、JSON 可解析、返回条目里带非空 vod_play_url。
 * 资源站换域名是常态，失效了删掉这一条即可（或换成新的）。
 *
 * **这份清单编进 Worker 包，运行期不改。** 不在这一页做「用户自定义源」：
 * 那需要持久化存储（KV / DO），而本站的原则是「常驻功能不额外开一个存储面」。
 * 访客侧的临时增删在浏览器 localStorage 里（见 public/tv/app.js 的 override）。
 */
export interface VodSource {
  /** 稳定 id，前端 localStorage 与健康度表都用它 */
  id: string;
  /** 展示名 */
  name: string;
  /** 接口基址，结尾必须带斜杠 */
  api: string;
  /** 一句话特点，设置面板里显示 */
  note?: string;
}

/**
 * 按 2026-10 实测延迟从低到高排列。
 * 顺序有意义：搜索是并发发起的，但**结果里同分候选按源顺序排**，
 * 快的源排在前面，多源命中时用户点开的就是最稳的那个。
 */
export const VOD_SOURCES: VodSource[] = [
  {
    id: 'js',
    name: '极速资源',
    api: 'https://jszyapi.com/api.php/provide/vod/',
    note: '延迟最低，m3u8 多线路',
  },
  {
    id: 'lz',
    name: '量子资源',
    api: 'https://cj.lziapi.com/api.php/provide/vod/',
    note: '老牌资源站',
  },
  {
    id: 'ffzy',
    name: '非凡资源',
    api: 'https://cj.ffzyapi.com/api.php/provide/vod/',
    note: '资源量大、更新快',
  },
  {
    id: 'dytt',
    name: '电影天堂',
    api: 'https://caiji.dyttzyapi.com/api.php/provide/vod/',
    note: '电影为主',
  },
  {
    id: 'gs',
    name: '光速资源',
    api: 'https://api.guangsuapi.com/api.php/provide/vod/',
    note: '线路稳定',
  },
  {
    id: 'bfzy',
    name: '暴风资源',
    api: 'https://bfzyapi.com/api.php/provide/vod/',
    note: '命中数多',
  },
  {
    id: 'zuid',
    name: '最大资源',
    api: 'https://api.zuidapi.com/api.php/provide/vod/',
    note: '影视综艺齐全（分片无 CORS，播放走代理）',
  },
  {
    id: 'bdzy',
    name: '百度资源',
    api: 'https://api.apibdzy.com/api.php/provide/vod/',
    note: '备用源',
  },
  /* —— 以下是第二轮扩充（2026-10 实测 195 个候选里筛出来的）——
     **只保留后端互不相同的站**：像 ffzy3/4/5、api.ffzyapi.com 这些是同一家运营的镜像，
     catalog 完全重合，全加进来只会让搜索多发一倍的重复请求、多花一倍延迟，
     结果一模一样。去重后 8 → 15 个不同后端。

     选站判据三条：条目数、延迟、**确实能取到 m3u8 播放列表**。
     被剔除的两个典型（都是「看着能用、点了才发现不能播」，比直接挂掉更坑）：
       - `360zy.com` / `360zy.tv`：列表通、3 条正常，但详情里的 m3u8 主机
         `vod2.maowushi.com` 已 502。
       - `hong.hgyx.vip`（红果资源）：列表通、单页 13 条最多，但**两条线路分别指向
         腾讯视频与爱奇艺的官网剧集页**（`v.qq.com/x/cover/…`、`iqiyi.com/v_…`），
         要会员登录，`<video>` 永远播不出来。整个源因此剔除。 */
  {
    id: 'wujin',
    name: '无尽资源',
    api: 'https://api.wujinapi.com/api.php/provide/vod/',
    note: '快速稳定',
  },
  {
    id: 'huya',
    name: '虎牙资源',
    api: 'https://huyazy.net/api.php/provide/vod/',
    note: '1080p 线路',
  },
  {
    id: 'hn3',
    name: '红牛资源',
    api: 'https://www.hongniuzy3.com/api.php/provide/vod/',
    note: '直连 m3u8',
  },
  {
    id: 'hhzy',
    name: '豪华资源',
    api: 'https://hhzyapi.com/api.php/provide/vod/',
    note: '双线路，片源新',
  },
  {
    id: 'mdzy',
    name: '摩都资源',
    api: 'https://www.mdzyapi.com/api.php/provide/vod/',
    note: '体量较小',
  },
  {
    id: 'uku88',
    name: 'UKU 资源',
    api: 'https://api.ukuapi88.com/api.php/provide/vod/',
    note: '备用',
  },
  {
    id: 'subo',
    name: '苏波采集',
    api: 'https://subocaiji.com/api.php/provide/vod/',
    note: '直连 m3u8',
  },
];

/** 直播源（M3U 或 TVBOX `#genre#` txt）。实测 2026-10。 */
export interface LiveSource {
  id: string;
  name: string;
  url: string;
}

export const LIVE_SOURCES: LiveSource[] = [
  {
    id: 'iptv-cn',
    name: '中国频道',
    url: 'https://iptv-org.github.io/iptv/countries/cn.m3u',
  },
  {
    id: 'iptv-zho',
    name: '中文频道',
    url: 'https://iptv-org.github.io/iptv/languages/zho.m3u',
  },
  {
    id: 'zbds-m3u',
    name: 'ZBDS 综合',
    url: 'https://live.zbds.top/tv/iptv4.m3u',
  },
  {
    id: 'zbds-txt',
    name: 'ZBDS 频道表',
    url: 'https://live.zbds.top/tv/iptv4.txt',
  },
];

/** 搜索与解析的调参，集中一处，改行为只改这里 */
export const TV_TUNING = {
  /** 单个源的总死线（毫秒）。到点中断，只丢这一个源 */
  sourceTimeoutMs: 6500,
  /** 每个源最多翻几页（第一页拿到 pagecount 后决定实际翻页数） */
  maxPagesPerSource: 2,
  /** 单页返回条数上限（部分源不认 pg 参数，一次吐几百条，截断保护） */
  maxItemsPerPage: 60,
  /** 源连续失败多少次后临时停用 */
  failThreshold: 2,
  /** 临时停用时长度（毫秒） */
  cooldownMs: 5 * 60 * 1000,
  /** 搜索结果的边缘缓存秒数。短 —— 搜索要新鲜，但同一关键词的并发点击很多 */
  searchCacheSec: 30,
  /** 详情缓存秒数 */
  detailCacheSec: 300,
} as const;

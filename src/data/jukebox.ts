/**
 * 点歌台 —— 上游契约与 Worker／页面共用的常量。
 *
 * 上游是沉麟自己那台 `yinyueku.cn`（MKOnlinePlayer v2.41 部署）的 `api.php`，
 * 它再转发到网易云。**浏览器不能直连它**：一个 CORS 头都没有，且 https 证书已过期，
 * 只有 http 能通 —— 本站是 https，fetch http 是 mixed content。所以必须过一跳
 * 自己的 Worker（`src/worker.ts`），这也是本站第一次有服务端代码。
 *
 * 音频字节**不经过 Worker**：直链是 https、`Access-Control-Allow-Origin: *`、支持
 * Range（206）、不校验 Referer，浏览器直接从 `music.126.net` 拉。Worker 只中转
 * 几百字节到几十 KB 的 JSON —— 这是这功能能在免费档跑的前提，别改成中转音频。
 *
 * ## 上游契约（本机实测，2026-08-21/22）
 *
 * `POST http://yinyueku.cn/api.php`，`application/x-www-form-urlencoded`。
 * Content-Type **必须带**（去掉返回 HTML 错误页）；UA 可以为空（Worker 默认不带 UA）。
 *
 * | types     | 必需参数                              | 返回                                  |
 * | :-------- | :------------------------------------ | :------------------------------------ |
 * | `search`  | `count` `pages` `name`                | 数组，元素形如 RawTrack               |
 * | `playlist` | `id` `source=netease`                | 同上                                  |
 * | `url`     | `id`(=url_id) `source` `sign`         | `{url}`                               |
 * | `lyric`   | `id`(=lyric_id) `source` `song` `sign` | `{lyric,tlyric}`                     |
 * | `pic`     | `id`(=pic_id) `source` `song` `sign`  | `{url}`                               |
 *
 * 四条踩过的坑：
 *
 * 1. **`sign` 按 types 绑定**。同一个 sign 在 `url` 有效，在 `lyric`／`pic` 一律
 *    「签名错误！」—— 差的是 `song`（歌曲 id）：这两个 types 把它算进签名校验，
 *    `url` 不算。漏了 `song` 就永远拿不到歌词。
 * 2. **失败长得跟成功一模一样**：签名不对时返回的是 `{"url":"签名错误！"}` /
 *    `{"lyric":"签名错误！"}`，HTTP 200、JSON 合法、字段名也对。所以只校验形状
 *    会把「签名错误！」当直链和歌词吐给前端。必须校验**内容**：直链要
 *    `https://` 开头，歌词要含 `[mm:ss` 时间戳。见 worker.ts 的 pickUrl／pickLyric。
 * 3. **`sign` 是确定性哈希，不是一次性凭据**。同一首歌两次搜索 sign 完全相同，
 *    歌单里下发的 sign 也能直接用于 `url`。所以点歌队列可以存 sign，不必重搜。
 * 4. **`count` 是下限不是上限**：`count=10` 返回 13 条，`count=100` 返回 100 条，
 *    `count=200` 返回 0 条（上游炸了）。所以 count 必须夹在 100 以内。
 *
 * `types=userlist`（拉某人的全部歌单）**不可用**：透传网易云原始结构且被上游硬切在
 * 73194 字节，JSON 是不完整的。
 */

/** 一个榜单。id 同时是 Worker 的白名单键 */
export interface Chart {
  id: string;
  name: string;
}

/**
 * 默认曲库 = 网易云官方榜单。
 *
 * 为什么不是沉麟自己的歌单：他 `musicList.js` 里 20 个歌单有 19 个是
 * `source:"my"`，`api.php` 对它们一律返回 0 字节（实测两遍）。唯一还活着的
 * 「黑胶VIP热歌榜」（7785066739，50 首）与热歌榜重合 49/50 —— 是它的子集，
 * 收进来只会让 tab 里出现两个几乎一样的榜，所以不收。
 *
 * 名字用 `music.163.com/playlist?id=` 的 <title> 核对过，条数是逐个实测值：
 * 飙升 99、新歌 100、热歌 200、原创 100、说唱 50、古典 100、ACG 100、韩语 100。
 */
export const CHARTS: readonly Chart[] = [
  { id: '19723756', name: '飙升榜' },
  { id: '3778678', name: '热歌榜' },
  { id: '3779629', name: '新歌榜' },
  { id: '2884035', name: '原创榜' },
  { id: '991319590', name: '中文说唱榜' },
  { id: '71385702', name: 'ACG 榜' },
  { id: '745956260', name: '韩语榜' },
  { id: '71384707', name: '古典榜' },
];

/**
 * Worker 只接受白名单里的歌单 id。
 * 少了这道判断，`/api/music/list` 就是一个「任给 id 就拉网易云歌单」的公开代理。
 */
export function isChartId(id: string): boolean {
  return CHARTS.some((c) => c.id === id);
}

/** 搜索关键词字符上限。够长的中文歌名词组，又不至于让人拿它当传输通道 */
export const SEARCH_MAX_Q = 40;

/** 单次搜索返回条数上限。上游 count 是下限，所以拿回来还要自己截断 */
export const SEARCH_MAX_N = 30;

/** 榜单单次返回条数上限。热歌榜 200 条，留点余量 */
export const LIST_MAX_N = 220;

/**
 * Worker 出口与页面入口的公共形状。
 *
 * **没有封面**：`pic` 每首要单独打一次上游，一屏搜索结果就是 30 次往返；而唱片机
 * 的中心标签本来就是文字设计（`.vinyl__label-t`），没有放专辑图的位置。整条链路省掉。
 */
export interface JukeTrack {
  /** 歌曲 id。lyric／pic 的签名校验要用它（作为 `song` 参数） */
  songId: string;
  title: string;
  /** 多个歌手已经拼成一行，前端不再处理数组 */
  artist: string;
  album: string;
  /** 取直链用的 id，与 songId 常相等但不保证 */
  urlId: string;
  lyricId: string;
  /**
   * 上游返回的源名，按返回值透传、不写死。
   * 榜单恒为 netease；搜索会混着 netease 与 tencent（R14 的择优选源就在这两个源之间挑，
   * 所以「恒为 netease」那句旧口径已经不成立了）。
   */
  source: string;
  sign: string;
}

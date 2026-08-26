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

/**
 * 一个歌单。`id` 同时是 Worker 的白名单键；`key` 是它在三份词条表里的键 ——
 * **名字不写在这里**（R46）：chip 上那三个词三种语言各一份，住在 `i18n/*.ts` 的
 * `music.juke.charts`。
 */
export interface Chart {
  id: string;
  key: ChartKey;
}

/** 三个歌单的词条键。与 `i18n` 的 `music.juke.charts` 逐项对应 */
export type ChartKey = 'mine' | 'hot' | 'original';

/**
 * 曲库 = 沉麟自己的歌单 + 两个官方榜。
 *
 * R21 他的原话：「榜单只保留热歌榜、原创榜，添加我推荐的歌单
 * https://music.163.com/playlist?id=12607934375」。原先那八个官方榜里
 * 飙升／新歌／说唱／ACG／韩语／古典六个由此删掉。
 *
 * 12607934375 是他账号「层林暮土」的「我喜欢的音乐」（名字取自
 * `music.163.com/playlist?id=12607934375` 的 <title>），chip 上写「沉麟推荐」——
 * 访客一眼能认出这是站主挑的，而歌单原名对访客没有信息量。**实测 324 首**，
 * 上游 `types=playlist&source=netease` 返回 75786 字节的完整 JSON。
 *
 * 这条推翻了下面这段旧结论的适用范围：他 `musicList.js` 里 20 个歌单有 19 个是
 * `source:"my"`，`api.php` 对它们一律返回 0 字节 —— 那是 MKOnlinePlayer 的自建
 * 歌单，不是网易云歌单。**给网易云的真实歌单 id 就能取到**，这次的就是。
 *
 * 名字用 `music.163.com/playlist?id=` 的 <title> 核对过，条数是逐个实测值：
 * 沉麟推荐 324、热歌 200、原创 100。
 *
 * R46：chip 上的三个名字搬去了 `i18n/*.ts` 的 `music.juke.charts`。**这三个是标签
 * 不是实体名** —— 「沉麟推荐」本来就不是那个歌单在网易云上的名字（原名「我喜欢的音乐」，
 * 见上一段），它是给访客看的一句话；「热歌榜」「原创榜」同理，日文版页面上留着中文
 * 只会是漏译。歌单**内容**仍然是中文歌，那与 chip 上写什么语言无关。
 */
export const CHARTS: readonly Chart[] = [
  { id: '12607934375', key: 'mine' },
  { id: '3778678', key: 'hot' },
  { id: '2884035', key: 'original' },
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

/**
 * 歌单单次返回条数上限。
 * 「沉麟推荐」实测 324 首，旧上限 220 会把它截掉 104 首 —— 一键播放整张歌单就名不副实。
 * 330 是 324 加一点余量（他往歌单里再加几首不用改代码）。
 */
export const LIST_MAX_N = 330;

/**
 * Worker 出口与页面入口的公共形状。
 *
 * **封面按需取，不在列表里取**（R22① 把这条链路加回来了，旧口径「没有封面、整条链路
 * 省掉」由此作废）：`pic` 每首要单独打一次上游，一屏 30 条搜索结果就是 30 次往返 ——
 * 所以列表只带 `picId`，真正换到这首要播时才由前端打一次 `/api/music/pic`。
 * 结果列表里也没有封面位，不会触发那 30 次。
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
   * 取封面用的 id。**可能是空串** —— 上游偶有记录不带 `pic_id`，
   * 那就一直用唱片原来的文字标签，不影响播放，也不该因此把整条候选判死。
   */
  picId: string;
  /**
   * 上游返回的源名，按返回值透传、不写死。
   * 榜单恒为 netease；搜索会混着 netease 与 tencent（R14 的择优选源就在这两个源之间挑，
   * 所以「恒为 netease」那句旧口径已经不成立了）。
   */
  source: string;
  sign: string;
}

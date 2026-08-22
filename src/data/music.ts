/**
 * 唱片机的曲目表。
 *
 * 现在这两首是**自己用 ffmpeg 合成的环境音垫**，不是任何人的作品 ——
 * 占位需要一段真能播、有长度、能对上时间轴的音频，用别人的曲子会同时踩
 * 版权和「假内容」两条线。生成命令原样记在这里，方便重现或改参数：
 *
 *   ffmpeg -f lavfi -i "aevalsrc=exprs=0.20*sin(2*PI*110*t)*(0.60+0.40*sin(2*PI*0.110*t))\
 *     +0.13*sin(2*PI*164.81*t)*(0.50+0.50*sin(2*PI*0.070*t+1))\
 *     +0.10*sin(2*PI*261.63*t)*(0.50+0.50*sin(2*PI*0.050*t+2))\
 *     +0.07*sin(2*PI*329.63*t)*(0.50+0.50*sin(2*PI*0.043*t+3))\
 *     +0.04*sin(2*PI*440*t)*(0.50+0.50*sin(2*PI*0.031*t+4)):s=44100:d=64" \
 *     -af "aecho=0.8:0.9:70|190:0.30|0.17,lowpass=f=2500,afade=t=in:d=5,afade=t=out:st=59:d=5" \
 *     -c:a libmp3lame -b:a 64k -ac 1 public/audio/door-light.mp3
 *
 * 频率是 A 小调的 A2/E3/C4/E4/A4，各自挂一条极慢的振幅包络（0.031–0.11 Hz），
 * 所以听起来是缓慢起伏而不是一根死音。第二首降到 G 小调、低通更低，更闷一些。
 *
 * 换成真曲目时：把 mp3 放进 public/audio/，改这里的 title/subtitle/src/duration/lrc
 * 就够了，页面与播放器不用动。duration 要填准 —— 播放列表在音频一个字节都没
 * 下载时就要显示时长，靠的是这个值，不是 loadedmetadata。
 */

export interface Track {
  /** 用作 DOM id 与列表 key，也是文件名 */
  id: string;
  title: string;
  /** 标题下的一行小字：出处、写它时在干什么，随意 */
  subtitle: string;
  src: string;
  /** 秒，填实测值（ffprobe -show_entries format=duration） */
  duration: number;
  /**
   * 随片文字，标准 LRC 格式。这里放的不是歌词 —— 音垫没有词 ——
   * 而是跟着音乐走的几句自己的话。真曲目进来后换成歌词，格式不变。
   * 空字符串表示这首没有随片文字。
   */
  lrc: string;
}

export const TRACKS: Track[] = [
  {
    id: 'door-light',
    title: '门后有光',
    subtitle: '起始页那道门的声音版本',
    src: '/audio/door-light.mp3',
    duration: 64.19,
    lrc: `[00:00.50]（合成的环境音垫，A 小调）
[00:06.00]起始页那道门
[00:12.50]是先有的光
[00:19.00]后有的门框
[00:26.00]先把光调对
[00:32.50]再让形状长出来
[00:40.00]顺序反了
[00:45.50]就只剩一个亮的方块
[00:53.00]这一页也是这么做的
[01:00.00]（渐隐）`,
  },
  {
    id: 'late-desk',
    title: '桌前很晚',
    subtitle: '改同一行的第几遍已经不记得了',
    src: '/audio/late-desk.mp3',
    duration: 48.24,
    lrc: `[00:00.50]（合成的环境音垫，G 小调）
[00:05.50]凌晨两点
[00:11.00]屏幕是房间里唯一的光源
[00:18.00]改的其实还是同一行
[00:24.00]只是这次知道为什么
[00:31.00]「差不多」和「对」
[00:36.50]差的就是这几个小时
[00:43.00]（渐隐）`,
  },
];

export interface LrcLine {
  /** 秒 */
  time: number;
  text: string;
}

/**
 * 解析标准 LRC。支持一行挂多个时间戳（`[00:01.00][00:30.00]同一句`），
 * 也支持 `.` 与 `:` 两种小数分隔符、两位厘秒与三位毫秒。
 * 无文字的纯时间戳行会被丢掉 —— 渲染出来是个空的 <li>，只会撑乱行距。
 */
export function parseLrc(lrc: string): LrcLine[] {
  const out: LrcLine[] = [];

  for (const raw of lrc.split('\n')) {
    const row = raw.match(/^\s*((?:\[\d+:\d+(?:[.:]\d+)?\]\s*)+)(.*)$/);
    if (!row) continue;

    const text = row[2].trim();
    if (!text) continue;

    for (const stamp of row[1].matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)) {
      // '0.' + '50' → 0.5；'0.' + '500' → 0.5。厘秒毫秒都对
      const frac = stamp[3] ? Number('0.' + stamp[3]) : 0;
      out.push({ time: Number(stamp[1]) * 60 + Number(stamp[2]) + frac, text });
    }
  }

  return out.sort((a, b) => a.time - b.time);
}

/**
 * 把一行随片文字切成「能各自点亮的最小单位」：CJK 一字一段，拉丁字母与数字连成的词
 * 整段不切，尾随空白并进前一段。逐字淡化按这些段推进。
 *
 * 为什么需要它：逐字淡化原先在整行上铺一道 `linear-gradient(90deg)`，而 background 的
 * 渐变按元素**盒子**的宽度铺 —— 一行歌词在窄屏折成两个行盒时，两个行盒共用同一道渐变，
 * 于是第二行跟着第一行同步被点亮。切成一个个独立的 inline 盒子之后，每段自己一道渐变，
 * 与折不折行无关。
 *
 * 拉丁词不能拆到字母：每个字母一个 <span> 会在字母之间多出断行机会，
 * 「gold digger」在窄屏会被折成「g / old digger」。CJK 每字本来就可断行，拆开不影响排版。
 * 空白并进前一段是同一个理由 —— 断行机会仍然只落在空格上，不会多出来。
 *
 * `u` 标志是必需的：没有它 `\S` 按 UTF-16 码元匹配，会把 emoji 的代理对切成两半。
 */
export function segment(text: string): string[] {
  const out: string[] = [];
  // 顺序有意义：先试拉丁词（含词内的撇号与连字符），不成再退到单个字符。两者都吃掉尾随空白
  const re = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*\s*|\S\s*|\s+/gu;
  for (const m of text.matchAll(re)) out.push(m[0]);
  return out;
}

/** 秒 → m:ss。NaN 与负数都退成 0:00，进度条拖到边界时不会显示 NaN:NaN */
export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

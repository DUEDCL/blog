/**
 * 服务商预设（R41③）——「我必须能使用国内的服务商，无论你使用什么办法」。
 *
 * ## 为什么需要这张表
 *
 * 后台原来只有三个空输入框（端点／密钥／模型）。填对一家国内服务商要同时知道三件事：
 * 兼容模式的路径（各家都不一样，`/v1`、`/api/paas/v4`、`/api/v3`、`/compatible-mode/v1`）、
 * 该选哪种请求格式、以及**这家的域名 Cloudflare 边缘到底通不通**。
 * 三件里错一件，表现都是同一句「超时」或「HTTP 404」，查起来极慢 ——
 * R37 那次就是在这上面卡了一整轮。
 *
 * ## 端点是实测过的，不是抄来的
 *
 * 下面每一条的 `base` 都在 2026-08-25 用 `curl -H "authorization: Bearer test" <base>/models`
 * 打过一次，**14 条全部返回 401**（千帆返回 403）——`401` 恰好是最好的证据：
 * 主机存在、路径对、只是密钥不对。返回 404 才说明路径拼错了。
 *
 * ## `domestic` 这一列的真实含义
 *
 * 它标的是「这家的服务器在中国大陆」。**它不改变请求怎么发**，只影响后台怎么解读超时：
 * 线上是 Cloudflare 的境外边缘出网，跨境到大陆的链路本来就不稳。
 * 但**不要把它读成「大陆的一律打不通」** —— R37 那次的结论是「**那一家中转站**在区别对待
 * workerd 的请求」（同一个 Worker 打 `api.openai.com` 0.5 秒就有 401），
 * 不是所有大陆端点都不通。到底通不通，用后台的「探一下能不能连」当场测，别猜。
 *
 * 有 `intl` 的那几家给了**境外镜像域名**：同一家服务商的海外站，从 Cloudflare 边缘打过去
 * 不跨境。代价是海外站与国内站**多数是两套账号、两把密钥**（阿里、智谱、月之暗面、
 * 硅基流动都是这样），换域名的同时要换 key。
 */

/** 一家服务商的预设。`proto` 全是 `openai` —— 国内这几家的兼容模式都是 OpenAI 那套形状 */
export interface Provider {
  /** 后台按钮上显示的名字 */
  name: string;
  /** 兼容模式端点，填进「端点」那一栏。已含版本段，后面直接接 `/chat/completions` */
  base: string;
  /** 境外镜像域名（同一家的海外站）。没有的留空 */
  intl?: string;
  /** 服务器在中国大陆 */
  domestic: boolean;
  /** 常见模型名，填进「模型」那一栏当起点。真实可用列表用「拉取可用模型」拉 */
  models: string;
  /** 一句话说明：去哪拿密钥、有什么坑 */
  note: string;
}

/**
 * 按「国内最常用」排序。这不是推荐榜 —— 前四家是社区里被写进教程最多的四家，
 * 排前面只是为了少滚一次。
 */
export const PROVIDERS: Provider[] = [
  {
    name: 'DeepSeek',
    base: 'https://api.deepseek.com/v1',
    domestic: true,
    models: 'deepseek-chat, deepseek-reasoner',
    note: '密钥在 platform.deepseek.com。域名本身有全球接入，是这几家里最可能一次就通的。',
  },
  {
    name: '阿里百炼（通义千问）',
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    intl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    domestic: true,
    models: 'qwen-plus, qwen-turbo, qwen-max',
    note: '密钥在 bailian.console.aliyun.com。境外镜像是新加坡站，**账号与密钥另算**。',
  },
  {
    name: '智谱 GLM',
    base: 'https://open.bigmodel.cn/api/paas/v4',
    intl: 'https://api.z.ai/api/paas/v4',
    domestic: true,
    models: 'glm-4.5-air, glm-4.5, glm-4-flash',
    note: '密钥在 bigmodel.cn。境外镜像是它的海外品牌 Z.ai，**账号与密钥另算**。',
  },
  {
    name: '月之暗面 Kimi',
    base: 'https://api.moonshot.cn/v1',
    intl: 'https://api.moonshot.ai/v1',
    domestic: true,
    models: 'kimi-k2-turbo-preview, moonshot-v1-8k',
    note: '密钥在 platform.moonshot.cn。境外站 platform.moonshot.ai **账号与密钥另算**。',
  },
  {
    name: '硅基流动',
    base: 'https://api.siliconflow.cn/v1',
    intl: 'https://api.siliconflow.com/v1',
    domestic: true,
    models: 'deepseek-ai/DeepSeek-V3, Qwen/Qwen3-8B',
    note: '聚合站：一把密钥调很多家的模型，有免费额度。境外站 .com **账号与密钥另算**。',
  },
  {
    name: '火山方舟（豆包）',
    base: 'https://ark.cn-beijing.volces.com/api/v3',
    domestic: true,
    models: 'doubao-seed-1-6-250615',
    note: '密钥在 console.volcengine.com/ark。模型名要用控制台里的**接入点 ID 或模型 ID**，不是「豆包」。',
  },
  {
    name: '腾讯混元',
    base: 'https://api.hunyuan.cloud.tencent.com/v1',
    domestic: true,
    models: 'hunyuan-turbos-latest, hunyuan-lite',
    note: '密钥在 console.cloud.tencent.com/hunyuan。hunyuan-lite 长期免费。',
  },
  {
    name: '百度千帆',
    base: 'https://qianfan.baidubce.com/v2',
    domestic: true,
    models: 'ernie-4.5-turbo-128k, ernie-speed-128k',
    note: '密钥在 console.bce.baidu.com/qianfan。要用 v2 的「API Key」，不是老的 AK/SK 那一对。',
  },
  {
    name: 'MiniMax',
    base: 'https://api.minimaxi.com/v1',
    domestic: true,
    models: 'MiniMax-M1, abab6.5s-chat',
    note: '密钥在 platform.minimaxi.com。国内站与国际站域名只差一个字母，别混。',
  },
  {
    name: '讯飞星火',
    base: 'https://spark-api-open.xf-yun.com/v1',
    domestic: true,
    models: 'lite, generalv3.5',
    note: '密钥在 console.xfyun.cn，用「HTTP 服务接口认证」那把（形如 key:secret 的组合）。lite 免费。',
  },
  {
    name: 'OpenAI（对照用）',
    base: 'https://api.openai.com/v1',
    domestic: false,
    models: 'gpt-4o-mini',
    note: '留着当**对照组**：探测时它 0.5 秒回 401 就说明边缘出网是好的，超时才是出网坏了。',
  },
];

/**
 * 探测时的**两个**对照端点。它们的作用是回答「出网本身是好的吗」——
 * R37 那一整轮就是靠这个对照把「代码写错」「密钥不对」「上游在拦我」三者分开的
 * （同一个 Worker 打 `api.openai.com` 0.5 秒拿到 401，打那家中转站 30 秒无响应）。
 *
 * **为什么要两个**：探测代码既跑在 Cloudflare 的境外边缘上，也跑在他本机的
 * `wrangler dev` 里，而这两个位置能到的地方不一样 —— 本机在国内，`api.openai.com`
 * 直接超时（实测 10 秒无响应）。只有一个境外对照的话，本机上每次探测都会得出
 * 「出网坏了」，而那是假的。所以给一个境外的、一个国内可达的：
 * **任意一个通就说明出网没问题**，这时目标不通就是目标自己的事。
 *
 * 探测只看「能不能拿到响应头」，所以不需要真密钥（401 也算通）。
 */
export const CONTROLS = [
  { label: 'api.openai.com', base: 'https://api.openai.com/v1' },
  { label: 'api.deepseek.com', base: 'https://api.deepseek.com/v1' },
] as const;

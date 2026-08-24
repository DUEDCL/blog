/**
 * `/kb.json` —— 知识库的机器出口，**给本站 Worker 里的 `/api/chat` 用**。
 *
 * 它是构建产物里的一个普通静态文件，所以：
 * - Worker 用 `env.ASSETS.fetch('/kb.json')` 就能拿到，不需要 astro:content；
 * - 它跟着每次部署一起更新，知识库改了就自动生效，没有第二处要同步。
 *
 * 这个文件是公开可取的。**这是知情的**：这 24 条本来就要通过站上的 AI 对外回答，
 * 而且仓库本身就是公开的（`kb/is-code-open.md`）。别往知识库里写不能公开的东西。
 */
import type { APIRoute } from 'astro';
import { getKb } from '../utils/kb';

export const GET: APIRoute = async () => {
  const items = await getKb();

  return new Response(JSON.stringify({ count: items.length, items }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // 站内自用的数据面，不进搜索结果
      'x-robots-tag': 'noindex',
    },
  });
};

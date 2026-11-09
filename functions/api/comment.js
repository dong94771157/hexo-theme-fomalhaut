/* Cloudflare Pages Function —— /api/comment 评论接口（D1 存储）
 * ---------------------------------------------------------------------------
 * 端点：
 *   GET   /api/comment?path=<pagePath>&page=<n>&size=<n>  获取评论列表（含回复）
 *   POST  /api/comment   提交评论  { path, nick, email, link, content, parentId, honeypot }
 *   PATCH /api/comment   点赞      { id }
 *   OPTIONS             CORS 预检
 *
 * D1 绑定变量名：COMMENTS_DB（在 Cloudflare Pages → 设置 → 函数 → D1 绑定中添加）
 * 数据库：blog-comments (6a22ca68-11ba-40b3-b862-c2411d11148e)
 */

const MAX_CONTENT = 2000;
const MAX_NICK = 30;
const DEFAULT_SIZE = 10;
const MAX_SIZE = 50;
const RATE_WINDOW = 60_000; // 1 分钟
const RATE_MAX = 3;         // 每分钟最多 3 条
const ALLOWED_SUFFIXES = ['ldwl.dpdns.org', 'dpdns.org'];

/* ---------- 工具 ---------- */

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
}

function escapeHtml(str) {
  // 用拼接构造实体，避免写入时被工具自动解码
  const E = { '&': '&'+'amp;', '<': '&'+'lt;', '>': '&'+'gt;', '"': '&'+'quot;', "'": '&'+'#x27;' };
  return String(str == null ? '' : str).replace(/[&<>"']/g, ch => E[ch]);
}

/* 服务端渲染受限 Markdown：**粗体** *斜体* `代码` [文字](https链接) > 引用 */
function renderContent(text) {
  let h = escapeHtml(text);
  h = h.replace(/```([\s\S]*?)```/g, (_, c) => '<pre><code>' + c + '</code></pre>');
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener nofollow">$1</a>');
  const GT = '&'+'gt;'; // escapeHtml 后 > 的实体形式
  h = h.replace(new RegExp('^' + GT + ' ?(.+)$', 'gm'), '<blockquote>$1</blockquote>');
  h = h.replace(/\n/g, '<br>');
  // 清理 blockquote 内多余的 br
  h = h.replace(/<\/blockquote><br>/g, '</blockquote>');
  return h;
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function checkOrigin(request) {
  const origin = request.headers.get('origin') || '';
  if (!origin) return true; // 同源/curl 无 origin，放行
  try {
    const host = new URL(origin).hostname;
    return ALLOWED_SUFFIXES.some(s => host === s || host.endsWith('.' + s));
  } catch { return false; }
}

function formatComment(c) {
  return {
    id: c.id,
    nick: c.nick,
    link: c.link || '',
    content: c.content,
    contentHtml: renderContent(c.content),
    parentId: c.parent_id || 0,
    createdAt: c.created_at,
    likes: c.likes || 0,
    avatar: c.email
      ? 'https://cravatar.cn/avatar/' + c.email_hash + '?d=monsterid&s=80'
      : 'https://cravatar.cn/avatar/' + c.nick_hash + '?d=identicon&s=80',
  };
}

/* ---------- GET：评论列表 ---------- */

export async function onRequestGet({ request, env }) {
  if (!env.COMMENTS_DB) return json({ error: 'D1 binding COMMENTS_DB not configured' }, 500);

  const url = new URL(request.url);
  const path = (url.searchParams.get('path') || '').trim();
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const size = Math.min(MAX_SIZE, Math.max(1, parseInt(url.searchParams.get('size') || String(DEFAULT_SIZE), 10) || DEFAULT_SIZE));

  if (!path) return json({ error: 'missing path' }, 400);

  const db = env.COMMENTS_DB;
  const offset = (page - 1) * size;

  // 主评论（parent_id=0），最新在前
  const { results: tops } = await db.prepare(
    'SELECT * FROM comments WHERE path = ? AND status = ? AND parent_id = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).bind(path, 'approved', size, offset).all();

  // 总数
  const { total } = await db.prepare(
    'SELECT COUNT(*) AS total FROM comments WHERE path = ? AND status = ? AND parent_id = 0'
  ).bind(path, 'approved').first();

  // 回复（旧→新）
  let replyMap = {};
  if (tops.length) {
    const ids = tops.map(c => c.id);
    const ph = ids.map(() => '?').join(',');
    const { results: replies } = await db.prepare(
      `SELECT * FROM comments WHERE parent_id IN (${ph}) AND status = 'approved' ORDER BY created_at ASC`
    ).bind(...ids).all();
    for (const r of replies) {
      (replyMap[r.parent_id] = replyMap[r.parent_id] || []).push(formatComment(r));
    }
  }

  return json({
    comments: tops.map(c => ({ ...formatComment(c), replies: replyMap[c.id] || [] })),
    total, page, size,
  });
}

/* ---------- POST：提交评论 ---------- */

export async function onRequestPost({ request, env }) {
  if (!env.COMMENTS_DB) return json({ error: 'D1 binding COMMENTS_DB not configured' }, 500);
  if (!checkOrigin(request)) return json({ error: 'origin not allowed' }, 403);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const { path, nick, email, link, content, parentId, honeypot } = body;

  // 蜜罐：机器人会填隐藏字段
  if (honeypot) return json({ error: 'spam detected' }, 403);

  // 校验
  if (!path || !content || !String(content).trim()) return json({ error: 'path 和 content 必填' }, 400);
  if (content.length > MAX_CONTENT) return json({ error: '评论过长（上限 2000 字）' }, 400);
  if (nick && String(nick).length > MAX_NICK) return json({ error: '昵称过长' }, 400);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: '邮箱格式不正确' }, 400);
  if (link && !/^https?:\/\/.+\..+/.test(link)) return json({ error: '网址格式不正确' }, 400);

  // 频率限制
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const ipHash = (await sha256hex(ip + '|twikoo-salt')).slice(0, 32);
  const now = Date.now();
  const { cnt } = await env.COMMENTS_DB.prepare(
    'SELECT COUNT(*) AS cnt FROM comments WHERE ip_hash = ? AND created_at > ?'
  ).bind(ipHash, now - RATE_WINDOW).first();
  if (cnt >= RATE_MAX) return json({ error: '评论太快啦，请 1 分钟后再试' }, 429);

  // 邮箱/昵称哈希（用于头像，不存明文邮箱）
  const emailHash = email ? (await sha256hex(email.toLowerCase().trim())).slice(0, 32) : '';
  const nickHash = (await sha256hex(String(nick || '匿名'))).slice(0, 32);

  const result = await env.COMMENTS_DB.prepare(
    `INSERT INTO comments (path, nick, email, link, content, parent_id, created_at, ua, ip_hash, email_hash, nick_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    String(path).slice(0, 200),
    String(nick || '匿名').trim().slice(0, MAX_NICK),
    email ? String(email).toLowerCase().trim() : '',
    link ? String(link).trim().slice(0, 200) : '',
    String(content).trim().slice(0, MAX_CONTENT),
    parentId ? parseInt(parentId, 10) || 0 : 0,
    now,
    (request.headers.get('user-agent') || '').slice(0, 200),
    ipHash,
    emailHash,
    nickHash
  ).run();

  return json({ success: true, id: result.meta.last_row_id }, 201);
}

/* ---------- PATCH：点赞 ---------- */

export async function onRequestPatch({ request, env }) {
  if (!env.COMMENTS_DB) return json({ error: 'D1 binding COMMENTS_DB not configured' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const id = parseInt(body.id, 10);
  if (!id) return json({ error: 'missing id' }, 400);

  await env.COMMENTS_DB.prepare(
    'UPDATE comments SET likes = likes + 1 WHERE id = ? AND status = ?'
  ).bind(id, 'approved').run();

  const row = await env.COMMENTS_DB.prepare('SELECT likes FROM comments WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'comment not found' }, 404);

  return json({ success: true, likes: row.likes });
}

/* ---------- OPTIONS：CORS 预检 ---------- */

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
}
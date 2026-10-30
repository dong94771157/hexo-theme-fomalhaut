/* Cloudflare Pages Function —— /api/chat/completions 的同源代理
 * ---------------------------------------------------------------------------
 * 双后端支持：
 *   1. 配了 DEEPSEEK_API_KEY → 代理 DeepSeek API（OpenAI 兼容格式）
 *   2. 没配 DEEPSEEK_API_KEY 但有 AI 绑定 → 使用 Cloudflare Workers AI（免费，无需密钥）
 *
 * 部署链路：scripts/vercel-api-copy.js 在 hexo generate 之后把本文件拷成
 *           public/functions/api/chat/completions.js，随 hexo d 进产物仓库；
 *           Cloudflare Pages 自动部署时读取根目录的 functions/ → 路由 /api/chat/completions。
 *
 * 环境变量 / 绑定（Cloudflare Pages → 项目 → 设置）：
 *   【方式一 · 推荐，免费】设置 → 函数 → AI 绑定 → 添加，变量名填 AI
 *   【方式二】设置 → 变量和密钥 → 添加 DEEPSEEK_API_KEY（加密类型）
 *
 *   AI_PROXY_ORIGINS        可选，额外放行的来源域名
 *   DEEPSEEK_MODEL          可选，默认 deepseek-chat（仅 DeepSeek 模式）
 *   CF_AI_MODEL             可选，默认 @cf/meta/llama-3.1-8b-instruct（仅 Workers AI 模式）
 *   DEEPSEEK_API_BASE       可选，默认 https://api.deepseek.com
 *   AI_PROXY_MAX_PER_HOUR   可选，默认 120
 */

const MAX_TOKENS_CAP = 8192;
const MAX_BODY_BYTES = 400 * 1024;
const MAX_MESSAGES = 24;
const MAX_CHARS_PER_MSG = 40000;

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}
function fail(status, message) { return json({ error: { message: message } }, status); }

/* ------------------------------------------------------------------ 来源白名单 */
const DEFAULT_SUFFIXES = 'ldwl.dpdns.org,dpdns.org';

function normOrigin(s) {
  s = String(s == null ? '' : s).trim().replace(/\/+$/, '');
  if (!s) return '';
  if (s === '*') return '*';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.indexOf('*.') === 0) return s.toLowerCase();
  return 'https://' + s;
}
function extraOrigins(env) {
  return String((env && env.AI_PROXY_ORIGINS) || '').split(',').map(normOrigin).filter(Boolean);
}
function allowSuffixes(env) {
  return String((env && env.AI_PROXY_ALLOW_SUFFIXES) || DEFAULT_SUFFIXES)
    .split(',').map(function (s) { return String(s).trim().toLowerCase().replace(/^\.+/, ''); }).filter(Boolean);
}
function hostOk(host, env) {
  host = String(host || '').toLowerCase().replace(/:\d+$/, '');
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || /\.local$/.test(host)) return true;
  const extra = extraOrigins(env);
  if (extra.indexOf('*') >= 0) return true;
  for (let i = 0; i < extra.length; i++) {
    const h = extra[i].replace(/^https?:\/\//i, '');
    if (h.indexOf('*.') === 0) { const base = h.slice(2); if (host === base || host.endsWith('.' + base)) return true; }
    else if (host === h) return true;
  }
  if (/\.vercel\.app$/.test(host) || /\.pages\.dev$/.test(host)) return true;
  const suf = allowSuffixes(env);
  for (let i = 0; i < suf.length; i++) { if (host === suf[i] || host.endsWith('.' + suf[i])) return true; }
  return false;
}

function originAllowed(request, env) {
  const o = request.headers.get('origin') || '';
  const ref = request.headers.get('referer') || '';
  if (!o && !ref) return true;
  let host = '';
  try { host = new URL(o || ref).hostname; } catch (e) { return false; }
  return hostOk(host, env);
}

function clampNum(v, dflt, lo, hi) {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}
function upstreamBase(env) {
  return String((env && env.DEEPSEEK_API_BASE) || 'https://api.deepseek.com').replace(/\/+$/, '');
}
function modelName(env) {
  return String((env && env.DEEPSEEK_MODEL) || 'deepseek-chat');
}
function cfAiModel(env) {
  return String((env && env.CF_AI_MODEL) || '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
}
const hits = new Map();
function rateOk(env, request, ip) {
  const max = parseInt((env && env.AI_PROXY_MAX_PER_HOUR) || '', 10) || 120;
  const now = Date.now();
  if (hits.size > 5000) hits.clear();
  let rec = hits.get(ip);
  if (!rec || now - rec.t > 3600000) { rec = { t: now, n: 0 }; hits.set(ip, rec); }
  rec.n += 1;
  return rec.n <= max;
}

/* ==================== Workers AI 流式响应 → OpenAI SSE 格式转换 ==================== */
function wrapSSE(obj) {
  return 'data: ' + JSON.stringify(obj) + '\n\n';
}
function cfAiStreamToOpenAI(aiStream, model) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const id = 'chatcmpl-cf-' + Date.now();
  return new ReadableStream({
    async start(controller) {
      const reader = aiStream.getReader();
      let buffer = '';
      function emit(text) {
        if (text) controller.enqueue(encoder.encode(wrapSSE({
          id: id, object: 'chat.completion.chunk', model: model,
          choices: [{ index: 0, delta: { content: text } }]
        })));
      }
      function parseLine(line) {
        const t = line.trim();
        if (!t || t === 'data: [DONE]') return;
        const payload = t.startsWith('data:') ? t.slice(5).trim() : t;
        if (!payload || payload === '[DONE]') return;
        try {
          const chunk = JSON.parse(payload);
          emit(chunk.response || '');
        } catch (e) { /* skip non-JSON */ }
      }
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // 关键修复：Uint8Array 必须先解码成字符串
          buffer += typeof value === 'string' ? value : decoder.decode(value, { stream: true });
          const nl = buffer.split('\n');
          buffer = nl.pop();
          nl.forEach(parseLine);
        }
        if (buffer) parseLine(buffer);
        controller.enqueue(encoder.encode(wrapSSE({
          id: id, object: 'chat.completion.chunk', model: model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        })));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (e) {
        try {
          emit('\n[生成中断]');
          controller.enqueue(encoder.encode(wrapSSE({
            id: id, object: 'chat.completion.chunk', model: model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          })));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch (_) { /* ignore */ }
      } finally {
        controller.close();
      }
    }
  });
}
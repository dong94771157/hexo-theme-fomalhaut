/**
 * Cloudflare Pages Function — GitHub 贡献日历 API
 * 路由: GET /api/gitcalendar?user=<github-username>  或  /api/gitcalendar?<username>
 *
 * 抓取 GitHub 公开贡献页 HTML，解析为 hexo-filter-gitcalendar@1.0.9 期望的格式：
 *   { total: <number>, contributions: [ [{date,count}×7]×53 ] }
 *
 * 插件硬编码访问 contributions[0][0]、[47][6]、[48]、[51]、[52]，
 * 因此必须输出恰好 53 周，且第 0~51 周满 7 天；第 52 周（当前周）保持实际天数。
 *
 * GitHub 当前 HTML 结构（2024+）：
 *   <td ... data-date="2025-11-02" id="contribution-day-component-0-0" ... class="ContributionCalendar-day"></td>
 *   <tool-tip ... for="contribution-day-component-0-0" ...>No contributions on November 2nd.</tool-tip>
 * id/for 格式为 contribution-day-component-{day}-{week}：
 *   第一个数字是 day(0-6，周日~周六)，第二个数字是 week(0-52)。
 */

const DEFAULT_USER = 'dong94771157'
const CACHE_SECONDS = 3600
const TARGET_WEEKS = 53

// 从 tool-tip 文本提取贡献数："No contributions on ..." → 0；"11 contributions on ..." → 11
function extractCount(text) {
  const m = /(\d+)\s+contributions?/i.exec(text)
  return m ? parseInt(m[1], 10) : 0
}

function isoDate(dt) {
  return dt.toISOString().slice(0, 10)
}

// 解析 GitHub 贡献页 HTML → { total, contributions }
function parseContributions(html) {
  // 1. 收集 tool-tip 计数：key "day-week" → count
  //    注意 id/for 格式为 contribution-day-component-{day}-{week}（day 在前）
  const counts = new Map()
  const tipRe = /<tool-tip[^>]*?for="contribution-day-component-(\d+)-(\d+)"[^>]*>([\s\S]*?)<\/tool-tip>/g
  let m
  while ((m = tipRe.exec(html)) !== null) {
    counts.set(m[1] + '-' + m[2], extractCount(m[3]))
  }

  // 2. 收集格子：id 为 contribution-day-component-{day}-{week}，
  //    第一个数字是 day(0-6 周日~周六)，第二个数字是 week(0-52)
  const weeks = []
  const cellRe = /data-date="(\d{4}-\d{2}-\d{2})"[^>]*?id="contribution-day-component-(\d+)-(\d+)"/g
  while ((m = cellRe.exec(html)) !== null) {
    const date = m[1]
    const d = parseInt(m[2], 10) // day
    const w = parseInt(m[3], 10) // week
    if (!weeks[w]) weeks[w] = []
    weeks[w][d] = { date, count: counts.has(d + '-' + w) ? counts.get(d + '-' + w) : 0 }
  }

  // 3. 兜底：旧版 SVG rect 结构（<rect data-date=".." data-count=".." ..>）
  if (weeks.length === 0 || !weeks.some(Boolean)) {
    const days = []
    const rectRe = /<rect[^>]*data-date="(\d{4}-\d{2}-\d{2})"[^>]*data-count="(\d+)"[^>]*>/g
    while ((m = rectRe.exec(html)) !== null) {
      days.push({ date: m[1], count: parseInt(m[2], 10) })
    }
    if (days.length === 0) return null
    days.sort((a, b) => (a.date < b.date ? -1 : 1))
    const warr = []
    for (let i = 0; i < days.length; i += 7) warr.push(days.slice(i, i + 7))
    return normalize(warr)
  }

  return normalize(weeks)
}

// 归一化：恰好 53 周；第 0~51 周补满 7 天；第 52 周保持实际天数
function normalize(weeks) {
  // 清理空洞周
  for (let w = 0; w < weeks.length; w++) {
    if (!weeks[w]) weeks[w] = []
  }

  // 不足 53 周：在开头补零周（保留末尾的当前周，插件靠 contributions[52] 取"今天"）
  while (weeks.length < TARGET_WEEKS) {
    const firstDay = weeks[0][0]
    const base = firstDay ? new Date(firstDay.date + 'T00:00:00Z') : new Date()
    const newWeek = []
    for (let i = 0; i < 7; i++) {
      const dt = new Date(base)
      dt.setUTCDate(base.getUTCDate() - 7 + i)
      newWeek.push({ date: isoDate(dt), count: 0 })
    }
    weeks.unshift(newWeek)
  }
  // 超过 53 周：截断开头（保留末尾当前周）
  while (weeks.length > TARGET_WEEKS) weeks.shift()

  // 第 0~51 周补满 7 天（缺失的天从相邻天推算日期，count=0）
  for (let w = 0; w < TARGET_WEEKS - 1; w++) {
    const week = weeks[w]
    for (let d = 0; d < 7; d++) {
      if (!week[d]) {
        // 从本周已存在的天推算
        const ref = week.find(Boolean) || weeks[w + 1].find(Boolean)
        if (ref) {
          const base = new Date(ref.date + 'T00:00:00Z')
          // 推算 ref 在本周的位置
          const refIdx = week.indexOf(ref)
          const offset = refIdx >= 0 ? d - refIdx : d
          base.setUTCDate(base.getUTCDate() + offset)
          week[d] = { date: isoDate(base), count: 0 }
        } else {
          week[d] = { date: '1970-01-01', count: 0 }
        }
      }
    }
    // 压缩稀疏空洞
    weeks[w] = Array.from({ length: 7 }, (_, d) => week[d])
  }
  // 第 52 周：确保至少有 1 天且无空洞
  const last = weeks[52].filter(Boolean)
  if (last.length === 0) {
    const ref = weeks[51][6]
    const base = new Date(ref.date + 'T00:00:00Z')
    base.setUTCDate(base.getUTCDate() + 1)
    last.push({ date: isoDate(base), count: 0 })
  }
  weeks[52] = last

  const total = weeks.reduce(
    (s, week) => s + week.reduce((ws, day) => ws + (day ? day.count : 0), 0),
    0
  )
  return { total, contributions: weeks }
}

export async function onRequestGet(context) {
  const { request, waitUntil } = context
  const url = new URL(request.url)

  // 兼容 ?user=xxx 与插件默认拼接的无 key 格式 ?xxx
  let user = url.searchParams.get('user')
  if (!user && url.search.startsWith('?')) {
    const raw = url.search.slice(1)
    if (raw && !raw.includes('=')) user = raw
  }
  user = (user || DEFAULT_USER).replace(/[^a-zA-Z0-9-]/g, '')

  if (!user) {
    return json({ error: 'missing user param' }, 400)
  }

  // 边缘缓存：同 user 的请求 1 小时内直接命中
  const cacheKey = new Request('https://cache.local/api/gitcalendar?user=' + user, request)
  const cache = caches.default
  const cached = await cache.match(cacheKey)
  if (cached) return cached

  try {
    const res = await fetch('https://github.com/users/' + user + '/contributions', {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        accept: 'text/html'
      }
    })
    if (!res.ok) return json({ error: 'github responded ' + res.status }, 502)

    const data = parseContributions(await res.text())
    if (!data) return json({ error: 'failed to parse contributions' }, 502)

    const response = json(data, 200, { 'cache-control': 'public, max-age=' + CACHE_SECONDS })
    waitUntil(cache.put(cacheKey, response.clone()))
    return response
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500)
  }
}

function json(obj, status, extra) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*'
  }
  if (extra) Object.assign(headers, extra)
  return new Response(JSON.stringify(obj), { status, headers })
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-max-age': '86400'
    }
  })
}
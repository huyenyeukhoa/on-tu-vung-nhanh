const https = require('https');
const http = require('http');
const { URL } = require('url');

function fetchUrlText(targetUrl, timeoutMs = 4500, maxRedirects = 4) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      return reject(new Error('Invalid URL: ' + targetUrl));
    }
    let settled = false;
    let req = null;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      if (err) reject(err);
      else resolve(val);
    };
    const wallTimer = setTimeout(() => {
      try { if (req) req.destroy(); } catch (e) {}
      finish(new Error('Wall timeout fetching ' + targetUrl));
    }, timeoutMs);

    const client = parsed.protocol === 'http:' ? http : https;
    req = client.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(wallTimer);
        settled = true;
        let nextUrl = res.headers.location;
        if (nextUrl.startsWith('//')) nextUrl = parsed.protocol + nextUrl;
        else if (nextUrl.startsWith('/')) nextUrl = parsed.origin + nextUrl;
        return fetchUrlText(nextUrl, timeoutMs, maxRedirects - 1).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const contentType = String(res.headers['content-type'] || '').toLowerCase();
        const headAscii = buf.slice(0, 1024).toString('ascii').toLowerCase();
        if (contentType.includes('gb2312') || contentType.includes('gbk') || contentType.includes('gb18030') ||
            headAscii.includes('charset=gb2312') || headAscii.includes('charset="gb2312"') ||
            headAscii.includes('charset=gbk') || headAscii.includes('charset="gbk"')) {
          try {
            return finish(null, new TextDecoder('gb18030').decode(buf));
          } catch (e) {
            return finish(null, buf.toString('utf-8'));
          }
        }
        finish(null, buf.toString('utf-8'));
      });
      res.on('error', err => finish(err));
    });
    req.on('error', err => finish(err));
    req.on('timeout', () => {
      try { req.destroy(); } catch (e) {}
      finish(new Error('Timeout fetching ' + targetUrl));
    });
  });
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ldquo;/gi, '“')
    .replace(/&rdquo;/gi, '”')
    .replace(/&lsquo;/gi, '‘')
    .replace(/&rsquo;/gi, '’')
    .replace(/&mdash;/gi, '—')
    .replace(/&hellip;/gi, '…')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
}

function cleanJournalisticNoise(text) {
  if (!text) return '';
  let s = decodeHtmlEntities(text)
    .replace(/<[^>]+>/g, '')
    .replace(/^[　\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Strip leading dateline like "中新网北京10月19日电 (记者 张三)" or "人民网北京10月19日电" or "新华社北京10月19日电"
  s = s.replace(/^(?:中新网|中新社|新华社|人民网|人民日报|光明日报|科技日报|经济日报)[^电\n]{0,28}电\s*(?:[（(][^）)\n]{1,35}[）)])?\s*/u, '');
  s = s.replace(/^(?:本报讯|本报记者\s+[^\s　]{2,6})\s*(?:[（(][^）)\n]{1,30}[）)])?\s*/u, '');
  s = s.replace(/^(?:题|原标题)\s*[：:]\s*/u, '');
  // Strip trailing "(完)" or editor credit
  s = s.replace(/[（(]完[）)]\s*$/u, '').replace(/【编辑[：:][^】]*】/gu, '').replace(/[（(]责编[：:][^）)]*[）)]/gu, '').trim();
  return s;
}

function parseRssItems(xml, feedCategory, sourceName) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/i);
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/i);
    const descMatch = block.match(/<description>([\s\S]*?)<\/description>/i);
    const pubMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);

    const title = cleanJournalisticNoise(titleMatch ? titleMatch[1] : '');
    const link = decodeHtmlEntities(linkMatch ? linkMatch[1] : '').trim().replace(/^http:\/\//i, 'https://');
    const summary = cleanJournalisticNoise(descMatch ? descMatch[1] : '');
    const pubRaw = decodeHtmlEntities(pubMatch ? pubMatch[1] : '').trim();

    if (!title || !link) continue;

    let dateStr = '';
    let timestamp = 0;
    const urlDateMatch = link.match(/\/(\d{4})\/(\d{2})-(\d{2})\//);
    if (urlDateMatch) {
      dateStr = `${urlDateMatch[1]}-${urlDateMatch[2]}-${urlDateMatch[3]}`;
    }
    if (pubRaw) {
      const parsedTime = Date.parse(pubRaw);
      if (!isNaN(parsedTime)) {
        timestamp = parsedTime;
        if (!dateStr) {
          const d = new Date(parsedTime + 8 * 3600 * 1000);
          dateStr = d.toISOString().slice(0, 10);
        }
      }
    }
    if (!timestamp && dateStr) {
      timestamp = Date.parse(dateStr + 'T12:00:00+08:00') || 0;
    }

    items.push({
      title,
      link,
      summary: summary.slice(0, 220),
      dateStr: dateStr || 'Mới nhất',
      timestamp,
      feedCategory,
      source: sourceName
    });
  }
  return items;
}

function parsePeopleHtml(html, baseOrigin, feedCategory, sourceName) {
  const byUrl = new Map();
  const aRegex = /<a\b[^>]*href=["']((?:https?:\/\/[a-z0-9.]*people\.com\.cn)?\/n1\/(\d{4})\/(\d{2})(\d{2})\/c\d+-\d+\.html)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = aRegex.exec(html)) !== null) {
    const rawHref = m[1].trim();
    const dateStr = `${m[2]}-${m[3]}-${m[4]}`;
    const link = rawHref.startsWith('http') ? rawHref : (baseOrigin + rawHref);
    const text = cleanJournalisticNoise(m[5]);
    if (!text || text.length < 5) continue;
    if (/^(?:了解详情|更多|详细|全文|阅读全文)/.test(text)) continue;

    if (!byUrl.has(link)) {
      if (text.length <= 48) {
        byUrl.set(link, {
          title: text,
          link,
          summary: '',
          dateStr,
          timestamp: Date.parse(dateStr + 'T12:00:00+08:00') || 0,
          feedCategory,
          source: sourceName
        });
      }
    } else {
      const existing = byUrl.get(link);
      if (text.length > existing.title.length + 8 && !existing.summary) {
        existing.summary = text.slice(0, 220);
      }
    }
  }
  return Array.from(byUrl.values());
}

function parseXinhuaHtml(html, baseOrigin, feedCategory, sourceName) {
  const byUrl = new Map();
  const aRegex = /<a\b[^>]*href=["']((?:https?:\/\/www\.news\.cn)?\/[a-z0-9_-]+\/(\d{4})(\d{2})(\d{2})\/[a-f0-9]+\/c\.html)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = aRegex.exec(html)) !== null) {
    const rawHref = m[1].trim();
    const dateStr = `${m[2]}-${m[3]}-${m[4]}`;
    const link = rawHref.startsWith('http') ? rawHref : (baseOrigin + rawHref);
    const text = cleanJournalisticNoise(m[5]);
    if (!text || text.length < 6 || text.length > 52) continue;
    if (/（组图）|（视频）/.test(text)) continue;
    if (!byUrl.has(link)) {
      byUrl.set(link, {
        title: text,
        link,
        summary: '',
        dateStr,
        timestamp: Date.parse(dateStr + 'T12:00:00+08:00') || 0,
        feedCategory,
        source: sourceName
      });
    }
  }
  return Array.from(byUrl.values());
}

function extractArticleParagraphs(html) {
  if (!html) return [];
  let bodyRegion = '';

  // 1. Chinanews (中新网)
  const zwStart = html.indexOf('<div class="left_zw"');
  // 2. People's Daily / Kepu China (人民日报 / 人民网 / 科普中国)
  const rmStart = html.search(/<div\s+class=["'][^"']*(?:rm_txt_con|box_con|artDet)[^"']*["']|<div\s+id=["']rwb_zw["']/i);
  // 3. Xinhua (新华网)
  const xhStart = html.search(/id=["']detailContent["']|<div\s+id=["']detail["']|<div\s+class=["'][^"']*main-aticle[^"']*["']/i);

  if (zwStart !== -1) {
    const afterStart = html.slice(zwStart);
    const endMarker = afterStart.search(/<!--\s*正文end\s*-->|<div class="content_bottom|<div class="left_name"/i);
    bodyRegion = endMarker !== -1 ? afterStart.slice(0, endMarker) : afterStart.slice(0, 28000);
  } else if (rmStart !== -1) {
    const afterStart = html.slice(rmStart);
    const endMarker = afterStart.search(/<div\s+class=["'](?:edit|zdfy)|分享让更多人看到|[（(]责编[：:]|<!--left-banner-->/i);
    bodyRegion = endMarker !== -1 ? afterStart.slice(0, endMarker) : afterStart.slice(0, 28000);
  } else if (xhStart !== -1) {
    const afterStart = html.slice(xhStart);
    const endMarker = afterStart.search(/<div\s+class=["'](?:zan-wap|editor|p-tags)|【纠错】|【责任编辑/i);
    bodyRegion = endMarker !== -1 ? afterStart.slice(0, endMarker) : afterStart.slice(0, 28000);
  } else {
    bodyRegion = html;
  }

  const pRegex = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  const paragraphs = [];
  let m;
  while ((m = pRegex.exec(bodyRegion)) !== null) {
    const rawP = m[1];
    if (/class=["']pictext/i.test(rawP)) continue;
    const cleaned = cleanJournalisticNoise(rawP);
    if (!cleaned || cleaned.length < 8) continue;
    if (/^(?:资料图|图为|中新社记者|中新网记者|新华社记者|人民网记者|本报记者|图片来源|点击播报本文|更多精彩内容，请下载|返回人民网|分享让更多人看到)/.test(cleaned)) continue;
    if (/(?:摄\s*[（(](?:人民视觉|新华社发|人民网)|新华社发\s*[）)]$)/.test(cleaned) && cleaned.length < 75) continue;
    if (/^《\s*人民日报\s*》[（(]\s*\d{4}年/.test(cleaned)) continue;
    if (/^[（(]作者为[^）)]+[）)]$/.test(cleaned)) continue;
    paragraphs.push(cleaned);
  }
  return paragraphs;
}

const ALLOWED_ARTICLE_HOST_RE = /^https?:\/\/([a-z0-9-]+\.)*(chinanews\.com(\.cn)?|people\.com\.cn|news\.cn|xinhuanet\.com)\//i;

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const params = event.queryStringParameters || {};
  const mode = params.mode || 'list';

  try {
    if (mode === 'article') {
      const targetUrl = params.url || '';
      if (!targetUrl || !ALLOWED_ARTICLE_HOST_RE.test(targetUrl)) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'URL bài báo không hợp lệ' })
        };
      }
      const html = await fetchUrlText(targetUrl, 9500);
      const paragraphs = extractArticleParagraphs(html);
      if (paragraphs.length === 0) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Không trích xuất được nội dung bài báo gốc' })
        };
      }
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          url: targetUrl,
          paragraphs,
          fullText: paragraphs.join('\n\n')
        })
      };
    }

    // Default mode: 'list' — fetch live articles from the 4 authoritative HSK 7-9 official sources:
    // 1. 人民日报 / 人民网 (people.com.cn) — 時評, 科教, 健康民生, 文旅
    // 2. 科普中国 (kpzg.people.com.cn) — 前沿科技, 医学科普, 生态自然
    // 3. 新华网 (news.cn) — 科技与人工智能, 文化与非遗
    // 4. 中国新闻网 (chinanews.com.cn) — 文化, 社会, 健康, 教育, 产经
    const sourcesConfig = [
      // 1. 人民日报 / 人民网 (People's Daily)
      { type: 'people', url: 'http://opinion.people.com.cn/', origin: 'http://opinion.people.com.cn', category: '哲理·时评', source: '人民日报·时评', group: 'people' },
      { type: 'people', url: 'http://edu.people.com.cn/', origin: 'http://edu.people.com.cn', category: '教育·科研', source: '人民日报·科教', group: 'people' },
      { type: 'people', url: 'http://health.people.com.cn/', origin: 'http://health.people.com.cn', category: '健康·养老', source: '人民日报·健康', group: 'people' },
      { type: 'people', url: 'http://ent.people.com.cn/', origin: 'http://ent.people.com.cn', category: '文化·非遗', source: '人民日报·文旅', group: 'people' },
      { type: 'people', url: 'http://society.people.com.cn/', origin: 'http://society.people.com.cn', category: '社会·民生', source: '人民日报·社会', group: 'people' },

      // 2. 科普中国 (Kepu China - CAST & People's Daily)
      { type: 'people', url: 'http://kpzg.people.com.cn/', origin: 'http://kpzg.people.com.cn', category: '前沿·科普', source: '科普中国·人民网', group: 'kepu' },

      // 3. 新华网 (Xinhua News Agency)
      { type: 'xinhua', url: 'https://www.news.cn/tech/', origin: 'https://www.news.cn', category: 'AI·硬科技', source: '新华网·科技', group: 'xinhua' },

      // 4. 中国新闻网 (Chinanews)
      { type: 'rss', url: 'https://www.chinanews.com.cn/rss/culture.xml', category: '文化·遗产', source: '中新网·文化', group: 'chinanews' },
      { type: 'rss', url: 'https://www.chinanews.com.cn/rss/society.xml', category: '社会·百态', source: '中新网·社会', group: 'chinanews' },
      { type: 'rss', url: 'https://www.chinanews.com.cn/rss/jk.xml', category: '医学·健康', source: '中新网·健康', group: 'chinanews' },
      { type: 'rss', url: 'https://www.chinanews.com.cn/rss/life.xml', category: '生态·生活', source: '中新网·生活', group: 'chinanews' },
      { type: 'rss', url: 'https://www.chinanews.com.cn/rss/edu.xml', category: '教育·研学', source: '中新网·教育', group: 'chinanews' },
      { type: 'rss', url: 'https://www.chinanews.com.cn/rss/finance.xml', category: '科技·经济', source: '中新网·产经', group: 'chinanews' }
    ];

    const results = await Promise.allSettled(
      sourcesConfig.map(async cfg => {
        const raw = await fetchUrlText(cfg.url, 4500);
        let parsedItems = [];
        if (cfg.type === 'rss') {
          parsedItems = parseRssItems(raw, cfg.category, cfg.source);
        } else if (cfg.type === 'people') {
          parsedItems = parsePeopleHtml(raw, cfg.origin, cfg.category, cfg.source);
        } else if (cfg.type === 'xinhua') {
          parsedItems = parseXinhuaHtml(raw, cfg.origin, cfg.category, cfg.source);
        }
        return { group: cfg.group, items: parsedItems };
      })
    );

    const seenLinks = new Set();
    const seenTitles = new Set();
    const buckets = {
      people: [],
      kepu: [],
      xinhua: [],
      chinanews: []
    };
    const nowMs = Date.now();
    const maxAgeMs = 12 * 24 * 3600 * 1000; // Keep recent articles within last 12 days

    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value && Array.isArray(r.value.items)) {
        const group = r.value.group;
        r.value.items.forEach(item => {
          const normTitle = item.title.replace(/\s+/g, '');
          if (seenLinks.has(item.link) || seenTitles.has(normTitle)) return;
          if (item.timestamp > 0 && (nowMs - item.timestamp) > maxAgeMs) return;
          if (item.link.includes('/tp/') || item.link.includes('/shipin/')) return;
          seenLinks.add(item.link);
          seenTitles.add(normTitle);
          if (buckets[group]) buckets[group].push(item);
        });
      }
    });

    Object.keys(buckets).forEach(k => {
      buckets[k].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    });

    // Interleave across the 4 official media groups so Gemini AI gets a rich, balanced pool:
    // ~18 from 人民日报, ~10 from 科普中国, ~8 from 新华网, ~18 from 中新网 (total ~54 candidates)
    const balancedArticles = [
      ...buckets.people.slice(0, 18),
      ...buckets.kepu.slice(0, 10),
      ...buckets.xinhua.slice(0, 8),
      ...buckets.chinanews.slice(0, 18)
    ];

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        fetchedAt: new Date().toISOString(),
        totalFetched: balancedArticles.length,
        sourceCounts: {
          people: buckets.people.length,
          kepu: buckets.kepu.length,
          xinhua: buckets.xinhua.length,
          chinanews: buckets.chinanews.length
        },
        articles: balancedArticles
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || 'Lỗi máy chủ khi tải tin tức' })
    };
  }
};

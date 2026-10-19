const https = require('https');
const http = require('http');
const { URL } = require('url');

function fetchUrlText(targetUrl, timeoutMs = 9000, maxRedirects = 4) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      return reject(new Error('Invalid URL: ' + targetUrl));
    }
    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let nextUrl = res.headers.location;
        if (nextUrl.startsWith('/')) nextUrl = parsed.origin + nextUrl;
        return fetchUrlText(nextUrl, timeoutMs, maxRedirects - 1).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout fetching ' + targetUrl));
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
    .trim();
  // Strip leading dateline like "中新网北京10月19日电 (记者 张三)" or "中新社杭州10月19日电"
  s = s.replace(/^(?:中新网|中新社|新华社|人民网|光明日报)[^电\n]{0,25}电\s*(?:[（(][^）)\n]{1,30}[）)])?\s*/u, '');
  s = s.replace(/^(?:题|原标题)\s*[：:]\s*/u, '');
  // Strip trailing "(完)" or editor credit
  s = s.replace(/[（(]完[）)]\s*$/u, '').replace(/【编辑[：:][^】]*】/gu, '').trim();
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

    // Extract date from URL (/2026/10-19/) or pubDate
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

function extractArticleParagraphs(html) {
  if (!html) return [];
  let bodyRegion = '';
  const zwStart = html.indexOf('<div class="left_zw"');
  if (zwStart !== -1) {
    const afterStart = html.slice(zwStart);
    const endMarker = afterStart.search(/<!--\s*正文end\s*-->|<div class="content_bottom|<div class="left_name"/i);
    bodyRegion = endMarker !== -1 ? afterStart.slice(0, endMarker) : afterStart.slice(0, 25000);
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
    if (!cleaned || cleaned.length < 6) continue;
    if (/^(?:资料图|图为|中新社记者|中新网记者|新华社记者|图片来源)/.test(cleaned)) continue;
    paragraphs.push(cleaned);
  }
  return paragraphs;
}

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
      if (!targetUrl || !/^https?:\/\/([a-z0-9-]+\.)*chinanews\.com(\.cn)?\//i.test(targetUrl)) {
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

    // Default mode: 'list' — fetch live RSS feeds across HSK 7-9 relevant channels
    const feeds = [
      { url: 'https://www.chinanews.com.cn/rss/culture.xml', category: '文化·非遗', source: '中新网·文化' },
      { url: 'https://www.chinanews.com.cn/rss/society.xml', category: '社会·民生', source: '中新网·社会' },
      { url: 'https://www.chinanews.com.cn/rss/finance.xml', category: '科技·经济', source: '中新网·产经' },
      { url: 'https://www.chinanews.com.cn/rss/life.xml', category: '健康·生活', source: '中新网·生活' },
      { url: 'https://www.chinanews.com.cn/rss/jk.xml', category: '医学·科普', source: '中新网·健康' },
      { url: 'https://www.chinanews.com.cn/rss/edu.xml', category: '教育·研学', source: '中新网·教育' },
      { url: 'https://www.chinanews.com.cn/rss/theory.xml', category: '哲理·思想', source: '中新网·理论' },
      { url: 'https://www.chinanews.com.cn/rss/importnews.xml', category: '今日要闻', source: '中新网·要闻' }
    ];

    const results = await Promise.allSettled(
      feeds.map(async f => {
        const xml = await fetchUrlText(f.url, 7000);
        return parseRssItems(xml, f.category, f.source);
      })
    );

    const seenLinks = new Set();
    const seenTitles = new Set();
    const allItems = [];
    const nowMs = Date.now();
    const maxAgeMs = 10 * 24 * 3600 * 1000; // Strictly keep only recent articles (within last 10 days)

    results.forEach(r => {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        r.value.forEach(item => {
          if (seenLinks.has(item.link) || seenTitles.has(item.title)) return;
          if (item.timestamp > 0 && (nowMs - item.timestamp) > maxAgeMs) return;
          // Exclude pure photo-only galleries or video-only links
          if (item.link.includes('/tp/') || item.link.includes('/shipin/')) return;
          seenLinks.add(item.link);
          seenTitles.add(item.title);
          allItems.push(item);
        });
      }
    });

    allItems.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        fetchedAt: new Date().toISOString(),
        totalFetched: allItems.length,
        articles: allItems.slice(0, 48)
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

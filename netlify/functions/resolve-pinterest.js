const https = require('https');
const http = require('http');
const { URL } = require('url');

function followRedirects(targetUrl, maxRedirects = 6) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Quá nhiều lần chuyển hướng link'));

    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      return reject(new Error('Link URL không hợp lệ: ' + targetUrl));
    }

    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      timeout: 10000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith('/')) {
          redirectUrl = parsed.origin + redirectUrl;
        }

        // Canonicalize pin URL to clean /pin/<id>/ to avoid simplified /sent/ pages
        const pinMatch = redirectUrl.match(/\/pin\/(\d+)/);
        if (pinMatch && !redirectUrl.endsWith(`/pin/${pinMatch[1]}/`)) {
          redirectUrl = `https://www.pinterest.com/pin/${pinMatch[1]}/`;
        }

        return followRedirects(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
      }

      let chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          finalUrl: targetUrl,
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8')
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Hết thời gian chờ kết nối đến Pinterest'));
    });
  });
}

function extractPinterestMedia(rawHtml) {
  let media = {
    type: 'unknown',
    url: null,
    poster: null,
    title: null
  };

  // Normalize escaped slashes and unicode characters
  const html = (rawHtml || '').replace(/\\\//g, '/').replace(/\\u0026/g, '&');

  // 1. Check for MP4 video streams
  const mp4Regex = /https?:\/\/[^"'\s<>]+\.mp4(?:\?[^"'\s<>]*)?/gi;
  const rawMp4s = html.match(mp4Regex) || [];
  const cleanMp4s = [...new Set(rawMp4s)];

  if (cleanMp4s.length > 0) {
    // Prioritize 720p or expMp4
    const bestMp4 = cleanMp4s.find(u => u.includes('720w') || u.includes('720p') || u.includes('expMp4')) || cleanMp4s[0];
    media.type = 'video';
    media.url = bestMp4;
  }

  // 2. Poster image for video or primary image/gif
  const imgRegex = /https?:\/\/i\.pinimg\.com\/(?:originals|736x|1200x)\/[^"'\s<>]+\.(?:jpg|jpeg|png|webp|gif)/gi;
  const rawImgs = html.match(imgRegex) || [];
  const cleanImgs = [...new Set(rawImgs)];

  if (cleanImgs.length > 0) {
    const bestPoster = cleanImgs.find(u => u.includes('736x')) || cleanImgs[0];
    media.poster = bestPoster;

    if (!media.url) {
      const bestImg = cleanImgs.find(u => u.includes('originals')) || cleanImgs.find(u => u.includes('1200x')) || cleanImgs[0];
      media.type = bestImg.toLowerCase().includes('.gif') ? 'gif' : 'image';
      media.url = bestImg;
    }
  }

  // Fallback for title
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    media.title = titleMatch[1].replace(/\|.*$/g, '').trim();
  }

  return media;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8'
  };

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  let inputUrl = '';
  if (event.queryStringParameters && event.queryStringParameters.url) {
    inputUrl = event.queryStringParameters.url;
  } else if (event.body) {
    try {
      const parsedBody = JSON.parse(event.body);
      inputUrl = parsedBody.url || '';
    } catch (e) {}
  }

  inputUrl = (inputUrl || '').trim();
  if (!inputUrl) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ success: false, message: 'Thiếu tham số url' })
    };
  }

  try {
    const lower = inputUrl.toLowerCase();

    // Check direct file extensions
    if (lower.endsWith('.mp4') || lower.includes('.mp4?')) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, type: 'video', url: inputUrl, poster: null })
      };
    }
    if (lower.endsWith('.gif') || lower.includes('.gif?')) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, type: 'gif', url: inputUrl, poster: inputUrl })
      };
    }
    if (/\.(jpg|jpeg|png|webp)($|\?)/.test(lower)) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, type: 'image', url: inputUrl, poster: inputUrl })
      };
    }

    // Canonicalize if inputUrl is a direct pin link with tracking query params
    let fetchTargetUrl = inputUrl;
    const directPinMatch = inputUrl.match(/\/pin\/(\d+)/);
    if (directPinMatch && (inputUrl.includes('/sent/') || inputUrl.includes('?'))) {
      fetchTargetUrl = `https://www.pinterest.com/pin/${directPinMatch[1]}/`;
    }

    // Follow redirects & fetch page
    const { body, finalUrl } = await followRedirects(fetchTargetUrl);
    const media = extractPinterestMedia(body);

    if (!media.url) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          success: false,
          message: 'Không tìm thấy video hoặc ảnh từ link Pinterest này. Bạn hãy thử copy link ảnh trực tiếp từ Pinterest nhé.'
        })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        type: media.type,
        url: media.url,
        poster: media.poster,
        title: media.title,
        originalInput: inputUrl,
        finalUrl
      })
    };
  } catch (err) {
    console.error('Resolve error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        message: 'Lỗi phân giải link: ' + (err.message || 'Không thể tải link')
      })
    };
  }
};

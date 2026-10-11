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

function extractPinterestMedia(html) {
  let media = {
    type: 'unknown',
    url: null,
    poster: null,
    title: null
  };

  // 1. Try __PWS_DATA__
  try {
    const pwsMatch = html.match(/<script id="__PWS_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (pwsMatch) {
      const data = JSON.parse(pwsMatch[1]);
      function searchObj(obj) {
        if (!obj || typeof obj !== 'object') return;

        // Video check
        if (obj.videos && obj.videos.video_list) {
          const vList = obj.videos.video_list;
          const candidates = Object.values(vList).filter(v => v && v.url && (v.url.endsWith('.mp4') || v.url.includes('.mp4')));
          candidates.sort((a, b) => (b.width || 0) - (a.width || 0));
          if (candidates.length > 0 && !media.url) {
            media.type = 'video';
            media.url = candidates[0].url;
            if (candidates[0].thumbnail) media.poster = candidates[0].thumbnail;
          }
        }

        // Animated GIF or Image check
        if (obj.images && !media.poster) {
          const orig = obj.images.orig || obj.images['736x'] || obj.images['1200x'] || Object.values(obj.images)[0];
          if (orig && orig.url) media.poster = orig.url;
        }

        if (obj.title && !media.title) media.title = obj.title;
        if (obj.grid_title && !media.title) media.title = obj.grid_title;

        for (const k of Object.keys(obj)) {
          if (typeof obj[k] === 'object') searchObj(obj[k]);
        }
      }
      searchObj(data);
    }
  } catch (e) {
    // Ignore JSON parse errors
  }

  // 2. Video fallback regex
  if (!media.url) {
    const mp4Regex = /https?:\\\/\\\/[^"'\s\\]+?\.mp4(?:\?[^"'\s\\]*)?|https?:\/\/[^"'\s]+?\.mp4(?:\?[^"'\s]*)?/g;
    const mp4Raw = html.match(mp4Regex) || [];
    const cleanMp4s = [...new Set(mp4Raw.map(u => u.replace(/\\\//g, '/').replace(/\\u0026/g, '&')))];
    const bestMp4 = cleanMp4s.find(u => u.includes('720w') || u.includes('720p')) || cleanMp4s[0];
    if (bestMp4) {
      media.type = 'video';
      media.url = bestMp4;
    }
  }

  // 3. Image / GIF fallback regex
  if (!media.url) {
    const imgRegex = /https?:\\\/\\\/i\.pinimg\.com\\\/(?:originals|736x|1200x)\\\/[^"'\s\\]+?\.(?:jpg|jpeg|png|webp|gif)|https?:\/\/i\.pinimg\.com\/(?:originals|736x|1200x)\/[^"'\s]+?\.(?:jpg|jpeg|png|webp|gif)/g;
    const imgRaw = html.match(imgRegex) || [];
    const cleanImgs = [...new Set(imgRaw.map(u => u.replace(/\\\//g, '/')))];
    const bestImg = cleanImgs.find(u => u.includes('originals')) || cleanImgs.find(u => u.includes('1200x')) || cleanImgs[0];
    if (bestImg) {
      media.type = bestImg.toLowerCase().endsWith('.gif') ? 'gif' : 'image';
      media.url = bestImg;
      media.poster = bestImg;
    }
  }

  // Poster image fallback
  if (!media.poster) {
    const posterRegex = /https?:\\\/\\\/i\.pinimg\.com\\\/736x\\\/[^"'\s\\]+?\.(?:jpg|jpeg|png|webp)|https?:\/\/i\.pinimg\.com\/736x\/[^"'\s]+?\.(?:jpg|jpeg|png|webp)/g;
    const posters = html.match(posterRegex) || [];
    if (posters.length > 0) {
      media.poster = posters[0].replace(/\\\//g, '/');
    }
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

    // Follow redirects & fetch page
    const { body, finalUrl } = await followRedirects(inputUrl);
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

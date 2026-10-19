const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

function extractDouyinUrlFromText(rawInput) {
  if (!rawInput) return null;
  const text = String(rawInput).trim();
  const match = text.match(/https?:\/\/(?:v\.douyin\.com|www\.douyin\.com|www\.iesdouyin\.com|m\.douyin\.com|vt\.tiktok\.com|www\.tiktok\.com)\/[^\s"'<>，。！？；：【】（）()]+/i);
  if (match) {
    return match[0].replace(/[，。！？,.!?;:)\]】]+$/, '');
  }
  if (/^\d{18,20}$/.test(text)) {
    return `https://www.iesdouyin.com/share/video/${text}/`;
  }
  return null;
}

function extractVideoIdFromUrl(urlStr) {
  if (!urlStr) return '';
  const m = String(urlStr).match(/(?:\/video\/|\/note\/|modal_id=|aweme_id=|item_ids=)(\d{17,21})/);
  return m ? m[1] : '';
}

async function resolveShortUrlAndFetchHtml(shortUrl) {
  let currentUrl = shortUrl;
  let videoId = extractVideoIdFromUrl(currentUrl);
  let html = '';

  try {
    const res = await fetch(currentUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent': MOBILE_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      signal: AbortSignal.timeout(5500)
    });
    if (res.url) {
      currentUrl = res.url;
      const idFromFinal = extractVideoIdFromUrl(currentUrl);
      if (idFromFinal) videoId = idFromFinal;
    }
    html = await res.text();
    if (!videoId && html) {
      const idInHtml = html.match(/(?:video_id|aweme_id|itemId|group_id)["'\s:=]+["']?(\d{18,20})/i);
      if (idInHtml) videoId = idInHtml[1];
    }
  } catch (e) {}

  return { finalUrl: currentUrl, videoId, html };
}

function parseRouterDataFromHtml(html) {
  if (!html) return null;
  try {
    const routerMatch = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i);
    if (routerMatch && routerMatch[1]) {
      const routerJson = JSON.parse(routerMatch[1]);
      const loaderData = routerJson.loaderData || {};
      for (const key of Object.keys(loaderData)) {
        const pageData = loaderData[key];
        const itemInfo = pageData?.videoInfoRes?.item_list?.[0] || pageData?.item_list?.[0];
        if (itemInfo) {
          const desc = String(itemInfo.desc || '').trim();
          const durationMs = Number(itemInfo.video?.duration || itemInfo.duration || 0);
          const durationSec = durationMs > 1000 ? Math.round(durationMs / 1000) : Math.round(durationMs);
          const cover = itemInfo.video?.cover?.url_list?.[0] || itemInfo.video?.origin_cover?.url_list?.[0] || '';
          const uri = itemInfo.video?.play_addr?.uri || '';
          const rawUrlList = itemInfo.video?.play_addr?.url_list || [];
          let videoUrl = '';
          if (rawUrlList.length > 0) {
            videoUrl = String(rawUrlList[0]).replace('playwm', 'play');
          } else if (uri) {
            videoUrl = `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(uri)}&ratio=720p&line=0`;
          }
          const audioUrl = itemInfo.music?.play_url?.url_list?.[0] || '';
          if (videoUrl) {
            return {
              videoId: String(itemInfo.aweme_id || ''),
              title: desc || 'Video Douyin (抖音)',
              videoUrl: videoUrl.replace(/^http:\/\//i, 'https://'),
              audioUrl: audioUrl ? audioUrl.replace(/^http:\/\//i, 'https://') : '',
              cover: cover ? cover.replace(/^http:\/\//i, 'https://') : '',
              durationSec: durationSec || 0
            };
          }
        }
      }
    }
  } catch (e) {}

  try {
    const uriMatch = html.match(/"play_addr"\s*:\s*\{[^}]*"uri"\s*:\s*"([^"]+)"/);
    const descMatch = html.match(/"desc"\s*:\s*"([^"]*)"/);
    if (uriMatch && uriMatch[1]) {
      const uri = uriMatch[1];
      return {
        videoId: '',
        title: descMatch ? descMatch[1] : 'Video Douyin (抖音)',
        videoUrl: `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(uri)}&ratio=720p&line=0`,
        audioUrl: '',
        cover: '',
        durationSec: 0
      };
    }
  } catch (e) {}

  return null;
}

async function resolveViaIesDouyinShare(videoId, existingHtml = '') {
  if (!videoId && !existingHtml) return null;
  if (existingHtml) {
    const parsed = parseRouterDataFromHtml(existingHtml);
    if (parsed && parsed.videoUrl) {
      if (!parsed.videoId && videoId) parsed.videoId = videoId;
      return parsed;
    }
  }
  if (!videoId) return null;
  try {
    const shareUrl = `https://www.iesdouyin.com/share/video/${videoId}/`;
    const res = await fetch(shareUrl, {
      headers: {
        'User-Agent': MOBILE_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    const html = await res.text();
    const parsed = parseRouterDataFromHtml(html);
    if (parsed && parsed.videoUrl) {
      parsed.videoId = parsed.videoId || videoId;
      return parsed;
    }
  } catch (e) {}
  return null;
}

async function resolveViaTikwm(cleanUrl) {
  try {
    const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(cleanUrl)}&hd=1`;
    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent': MOBILE_UA,
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(5500)
    });
    if (!res.ok) return null;
    const json = await res.json();
    const d = json && json.data;
    if (!d || (!d.play && !d.hdplay && !d.wmplay)) return null;
    const rawPlay = d.play || d.hdplay || d.wmplay;
    const videoUrl = rawPlay.startsWith('http') ? rawPlay : `https://www.tikwm.com${rawPlay}`;
    const rawAudio = d.music || (d.music_info && d.music_info.play) || '';
    const audioUrl = rawAudio ? (rawAudio.startsWith('http') ? rawAudio : `https://www.tikwm.com${rawAudio}`) : '';
    const rawCover = d.cover || d.origin_cover || '';
    const cover = rawCover ? (rawCover.startsWith('http') ? rawCover : `https://www.tikwm.com${rawCover}`) : '';
    return {
      videoId: String(d.id || ''),
      title: String(d.title || 'Video Douyin (抖音)').trim(),
      videoUrl: videoUrl.replace(/^http:\/\//i, 'https://'),
      audioUrl: audioUrl.replace(/^http:\/\//i, 'https://'),
      cover: cover.replace(/^http:\/\//i, 'https://'),
      durationSec: Number(d.duration || 0)
    };
  } catch (e) {
    return null;
  }
}

async function resolveViaDouyinWtf(cleanUrl) {
  const endpoints = [
    `https://api.douyin.wtf/api/hybrid/video_data?url=${encodeURIComponent(cleanUrl)}&minimal=true`,
    `https://douyin.wtf/api/hybrid/video_data?url=${encodeURIComponent(cleanUrl)}&minimal=true`
  ];
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, {
        headers: { 'User-Agent': MOBILE_UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) continue;
      const json = await res.json();
      const d = json && json.data;
      if (!d) continue;
      const videoUrl =
        d.video_data?.nwm_video_url_HQ ||
        d.video_data?.nwm_video_url ||
        d.nwm_video_url ||
        '';
      if (!videoUrl) continue;
      return {
        videoId: String(d.aweme_id || ''),
        title: String(d.desc || 'Video Douyin (抖音)').trim(),
        videoUrl: String(videoUrl).replace(/^http:\/\//i, 'https://'),
        audioUrl: String(d.music?.play_url?.uri || d.music?.play_url?.url_list?.[0] || '').replace(/^http:\/\//i, 'https://'),
        cover: String(d.cover_data?.cover?.url_list?.[0] || '').replace(/^http:\/\//i, 'https://'),
        durationSec: Math.round(Number(d.duration || 0) / 1000) || Number(d.duration || 0)
      };
    } catch (e) {}
  }
  return null;
}

async function fetchMediaChunkFromUrl(targetUrl, startByte = 0, chunkLen = 1835008) {
  const start = Math.max(0, parseInt(startByte, 10) || 0);
  const len = Math.min(2621440, Math.max(65536, parseInt(chunkLen, 10) || 1835008));
  const end = start + len - 1;

  const resp = await fetch(targetUrl, {
    redirect: 'follow',
    headers: {
      'User-Agent': MOBILE_UA,
      'Referer': 'https://www.douyin.com/',
      'Range': `bytes=${start}-${end}`
    },
    signal: AbortSignal.timeout(7000)
  });

  if (!resp.ok && resp.status !== 206) {
    throw new Error(`Media HTTP ${resp.status}`);
  }

  const mimeType = String(resp.headers.get('content-type') || 'video/mp4').split(';')[0].trim().toLowerCase();
  const isPartial = resp.status === 206;
  let totalBytes = 0;
  if (isPartial) {
    const cr = String(resp.headers.get('content-range') || '');
    const m = cr.match(/\/(\d+)/);
    if (m) totalBytes = parseInt(m[1], 10);
  } else {
    totalBytes = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
  }

  const fullBuf = Buffer.from(await resp.arrayBuffer());
  const sliceBuf = isPartial ? fullBuf.subarray(0, len) : fullBuf.subarray(start, start + len);
  const eof = totalBytes > 0
    ? (start + sliceBuf.byteLength >= totalBytes)
    : (isPartial ? sliceBuf.byteLength < len : (start + sliceBuf.byteLength >= fullBuf.byteLength));

  return {
    base64: sliceBuf.toString('base64'),
    mimeType,
    start,
    fetchedBytes: sliceBuf.byteLength,
    totalBytes: totalBytes || fullBuf.byteLength,
    eof,
    finalMediaUrl: resp.url || targetUrl
  };
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const qParams = event.queryStringParameters || {};
  const action = String(qParams.action || '').trim();

  // Chunk proxy mode for downloading Douyin video/audio into browser IndexedDB & WebAudio decoder
  if (action === 'proxy_chunk') {
    try {
      const targetUrl = qParams.u || '';
      if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'URL media không hợp lệ.' }) };
      }
      const chunkRes = await fetchMediaChunkFromUrl(targetUrl, qParams.start || '0', qParams.len || '1835008');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(chunkRes)
      };
    } catch (err) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: err.message || 'Không thể tải luồng video Douyin.' })
      };
    }
  }

  try {
    let rawInput = qParams.url || '';
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      rawInput = body.url || rawInput;
    }

    const cleanUrl = extractDouyinUrlFromText(rawInput);
    if (!cleanUrl) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Không tìm thấy đường dẫn Douyin (抖音) hợp lệ. Hãy copy link chia sẻ từ app Douyin nhé!' })
      };
    }

    // Step 1: Resolve short URL and try parsing mobile share page + TikWM in parallel
    const [shortResolved, tikwmRes] = await Promise.all([
      resolveShortUrlAndFetchHtml(cleanUrl),
      resolveViaTikwm(cleanUrl)
    ]);

    let resolved = await resolveViaIesDouyinShare(shortResolved.videoId, shortResolved.html);
    if (!resolved || !resolved.videoUrl) {
      resolved = tikwmRes;
    }
    if (!resolved || !resolved.videoUrl) {
      if (shortResolved.finalUrl && shortResolved.finalUrl !== cleanUrl) {
        resolved = await resolveViaTikwm(shortResolved.finalUrl);
      }
    }
    if (!resolved || !resolved.videoUrl) {
      resolved = await resolveViaDouyinWtf(shortResolved.finalUrl || cleanUrl);
    }

    if (!resolved || !resolved.videoUrl) {
      return {
        statusCode: 422,
        headers,
        body: JSON.stringify({
          error: 'Video Douyin này đang bật chống tải tự động. Bạn hãy bấm Lưu video về điện thoại rồi chọn nút "📱 Tải video từ máy" ngay bên cạnh nhé!'
        })
      };
    }

    const durSec = Number(resolved.durationSec || 0);
    const durStr = durSec > 0
      ? `${String(Math.floor(durSec / 60)).padStart(2, '0')}:${String(durSec % 60).padStart(2, '0')}`
      : 'Douyin';

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        douyinId: resolved.videoId || String(Date.now()),
        title: resolved.title || 'Video Douyin (抖音)',
        videoUrl: resolved.videoUrl,
        audioUrl: resolved.audioUrl || '',
        cover: resolved.cover || '',
        durationSec: durSec,
        duration: durStr
      })
    };
  } catch (err) {
    console.error('resolve-douyin error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Lỗi khi phân tích link Douyin. Bạn có thể dùng nút "📱 Tải video từ máy" để học ngay nhé!' })
    };
  }
};

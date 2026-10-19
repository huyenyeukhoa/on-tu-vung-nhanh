const videoLessonRateLimitMap = new Map();

function extractYouTubeId(url) {
  if (!url) return null;
  const trimmed = String(url).trim();
  const regExp = /^.*(?:youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=|shorts\/)([^#\&\?]{11}).*/;
  const match = trimmed.match(regExp);
  if (match && match[1]) return match[1];
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  return null;
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

function cleanSubtitleSegmentText(rawText, preferredLang = 'zh') {
  if (!rawText) return '';
  const lines = String(rawText)
    .split(/\r?\n/)
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (lines.length === 0) return '';

  let out = '';
  if (preferredLang === 'zh' && lines.length > 1) {
    const hanziLines = lines.filter(l => /[\u4e00-\u9fff]/.test(l));
    if (hanziLines.length > 0) {
      out = hanziLines.join(' ').trim();
    } else {
      const numLine = lines.find(l => /^\d+[？?!.，,]*$/.test(l));
      out = numLine || lines.join(' ').trim();
    }
  } else {
    out = lines.join(' ').trim();
  }

  if (/请使用简体中文输出|以下是普通话的句子/.test(out)) return '';
  return out;
}

function normalizeSegments(rawSegments) {
  for (let i = 0; i < rawSegments.length - 1; i++) {
    if (rawSegments[i].end > rawSegments[i + 1].start) {
      rawSegments[i].end = rawSegments[i + 1].start;
    }
    if (rawSegments[i].end <= rawSegments[i].start) {
      rawSegments[i].end = Math.round((rawSegments[i].start + 2.5) * 100) / 100;
    }
  }
  return rawSegments;
}

function parseJson3Events(data, preferredLang = 'zh') {
  const events = (data && Array.isArray(data.events)) ? data.events : [];
  const rawSegments = [];
  for (const ev of events) {
    if (!ev || !Array.isArray(ev.segs)) continue;
    const rawText = ev.segs.map(s => (s && s.utf8) ? s.utf8 : '').join('');
    const text = cleanSubtitleSegmentText(rawText, preferredLang);
    if (!text) continue;
    const startMs = Number(ev.tStartMs || 0);
    const durMs = Number(ev.dDurationMs || 3000);
    const startSec = Math.round((startMs / 1000) * 100) / 100;
    const endSec = Math.round(((startMs + durMs) / 1000) * 100) / 100;
    if (rawSegments.length > 0 && rawSegments[rawSegments.length - 1].text === text) continue;
    rawSegments.push({ start: startSec, end: endSec, text });
  }
  return normalizeSegments(rawSegments);
}

function parseXmlTimedText(xmlText, preferredLang = 'zh') {
  if (!xmlText) return [];
  const rawSegments = [];
  const textTagRegex = /<text[^>]*start=["']([\d.]+)["'][^>]*dur=["']([\d.]+)["'][^>]*>([\s\S]*?)<\/text>/gi;
  let m;
  while ((m = textTagRegex.exec(xmlText)) !== null) {
    const startSec = Math.round(parseFloat(m[1]) * 100) / 100;
    const durSec = parseFloat(m[2]) || 2.5;
    const endSec = Math.round((startSec + durSec) * 100) / 100;
    const decoded = decodeHtmlEntities(m[3].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
    const cleanText = cleanSubtitleSegmentText(decoded, preferredLang);
    if (cleanText && (!rawSegments.length || rawSegments[rawSegments.length - 1].text !== cleanText)) {
      rawSegments.push({ start: startSec, end: endSec, text: cleanText });
    }
  }
  if (rawSegments.length > 0) return normalizeSegments(rawSegments);

  const pTagRegex = /<p[^>]*t=["'](\d+)["'][^>]*d=["'](\d+)["'][^>]*>([\s\S]*?)<\/p>/gi;
  while ((m = pTagRegex.exec(xmlText)) !== null) {
    const startSec = Math.round((parseInt(m[1], 10) / 1000) * 100) / 100;
    const durSec = (parseInt(m[2], 10) || 2500) / 1000;
    const endSec = Math.round((startSec + durSec) * 100) / 100;
    const decoded = decodeHtmlEntities(m[3].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
    const cleanText = cleanSubtitleSegmentText(decoded, preferredLang);
    if (cleanText && (!rawSegments.length || rawSegments[rawSegments.length - 1].text !== cleanText)) {
      rawSegments.push({ start: startSec, end: endSec, text: cleanText });
    }
  }
  return normalizeSegments(rawSegments);
}

function parseVttContent(vttText, preferredLang = 'zh') {
  if (!vttText) return [];
  const lines = String(vttText).split(/\r?\n/);
  const segments = [];
  const timeRegex = /(\d{2}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})/;

  const toSec = (ts) => {
    const parts = ts.replace(',', '.').split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return parts[0] * 60 + parts[1];
  };

  let i = 0;
  while (i < lines.length) {
    const match = lines[i].match(timeRegex);
    if (match) {
      const startS = Math.round(toSec(match[1]) * 100) / 100;
      const endS = Math.round(toSec(match[2]) * 100) / 100;
      i++;
      const textParts = [];
      while (i < lines.length && lines[i].trim() !== '') {
        const cleaned = decodeHtmlEntities(lines[i].replace(/<[^>]+>/g, '')).trim();
        if (cleaned && !/^\d+$/.test(cleaned)) textParts.push(cleaned);
        i++;
      }
      const fullText = cleanSubtitleSegmentText(textParts.join('\n'), preferredLang);
      if (fullText && (!segments.length || segments[segments.length - 1].text !== fullText)) {
        segments.push({ start: startS, end: Math.max(endS, startS + 1.5), text: fullText });
      }
    } else {
      i++;
    }
  }
  return normalizeSegments(segments);
}

function getOrderedCaptionTracks(captionTracks, preferredLang = 'zh') {
  if (!Array.isArray(captionTracks) || captionTracks.length === 0) return [];
  const langPriority = ['zh-Hans', 'zh-CN', 'zh-SG', 'zh', 'zh-TW', 'zh-Hant', 'en', 'en-US', 'en-GB'];
  const ordered = [];
  const seen = new Set();

  for (const pref of langPriority) {
    for (const t of captionTracks) {
      if (!t || !t.baseUrl || seen.has(t.baseUrl)) continue;
      if (String(t.languageCode || '').toLowerCase() === pref.toLowerCase()) {
        ordered.push(t);
        seen.add(t.baseUrl);
      }
    }
    for (const t of captionTracks) {
      if (!t || !t.baseUrl || seen.has(t.baseUrl)) continue;
      if (String(t.languageCode || '').toLowerCase().startsWith(pref.toLowerCase())) {
        ordered.push(t);
        seen.add(t.baseUrl);
      }
    }
  }
  for (const t of captionTracks) {
    if (t && t.baseUrl && !seen.has(t.baseUrl)) {
      ordered.push(t);
      seen.add(t.baseUrl);
    }
  }
  return ordered;
}

async function fetchTrackContent(baseUrl, preferredLang = 'zh') {
  const urlsToTry = [
    baseUrl.includes('fmt=') ? baseUrl : `${baseUrl}&fmt=json3`,
    baseUrl.includes('fmt=') ? baseUrl.replace(/fmt=[^&]+/, 'fmt=srv3') : `${baseUrl}&fmt=srv3`,
    baseUrl
  ];

  for (const url of urlsToTry) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,vi;q=0.7'
        }
      });
      if (!res.ok) continue;
      const body = await res.text();
      if (!body || !body.trim()) continue;
      if (body.trim().startsWith('{')) {
        const parsed = parseJson3Events(JSON.parse(body), preferredLang);
        if (parsed.length > 0) return parsed;
      } else if (body.includes('WEBVTT') || body.includes('-->')) {
        const parsed = parseVttContent(body, preferredLang);
        if (parsed.length > 0) return parsed;
      } else if (body.includes('<text') || body.includes('<p ')) {
        const parsed = parseXmlTimedText(body, preferredLang);
        if (parsed.length > 0) return parsed;
      }
    } catch (e) {}
  }
  return [];
}

async function fetchBestTrackFromList(captionTracks, preferredLang = 'zh') {
  const ordered = getOrderedCaptionTracks(captionTracks, preferredLang);
  for (const track of ordered) {
    const segs = await fetchTrackContent(track.baseUrl, preferredLang);
    if (!segs || segs.length === 0) continue;
    const hanziCount = segs.filter(s => /[\u4e00-\u9fff]/.test(s.text)).length;
    if (hanziCount < Math.max(1, Math.floor(segs.length * 0.25))) {
      continue;
    }
    return segs;
  }
  return [];
}

async function fetchWatchPageInfo(ytId, preferredLang) {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${ytId}&hl=zh-CN`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      signal: AbortSignal.timeout(2500)
    });
    if (!res.ok) return { visitorData: '', segments: [], durationSec: 0 };
    const html = await res.text();
    const visitorMatch = html.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/);
    const visitorData = visitorMatch ? visitorMatch[1] : '';

    let durationSec = 0;
    const lenSecMatch = html.match(/"lengthSeconds"\s*:\s*"(\d+)"/);
    if (lenSecMatch) {
      durationSec = parseInt(lenSecMatch[1], 10) || 0;
    } else {
      const approxMatch = html.match(/"approxDurationMs"\s*:\s*"(\d+)"/);
      if (approxMatch) {
        durationSec = Math.round((parseInt(approxMatch[1], 10) || 0) / 1000);
      }
    }

    let segments = [];
    const match = html.match(/"captionTracks":\s*(\[[\s\S]*?\])/);
    if (match) {
      try {
        const tracks = JSON.parse(match[1]);
        segments = await fetchBestTrackFromList(tracks, preferredLang);
      } catch (e) {}
    }
    return { visitorData, segments, durationSec };
  } catch (e) {
    return { visitorData: '', segments: [], durationSec: 0 };
  }
}

async function downloadAudioFormatInChunks(audioFmt, userAgent, maxBytes = 3932160) {
  if (!audioFmt || !audioFmt.url) return null;
  try {
    const rawLen = parseInt(audioFmt.contentLength || '0', 10);
    const totalLen = rawLen > 0 ? Math.min(rawLen, maxBytes) : 2621440;
    const chunkSize = 524288;
    const ranges = [];
    for (let start = 0; start < totalLen; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, totalLen - 1);
      ranges.push([start, end]);
    }

    const buffers = await Promise.all(
      ranges.map(async ([start, end]) => {
        const sep = audioFmt.url.includes('?') ? '&' : '?';
        const r = await fetch(`${audioFmt.url}${sep}range=${start}-${end}`, {
          headers: { 'User-Agent': userAgent },
          signal: AbortSignal.timeout(4000)
        });
        if (!r.ok && r.status !== 206) {
          throw new Error(`Chunk HTTP ${r.status}`);
        }
        return Buffer.from(await r.arrayBuffer());
      })
    );

    const combined = Buffer.concat(buffers);
    if (combined.byteLength < 1024) return null;
    return {
      base64: combined.toString('base64'),
      mimeType: String(audioFmt.mimeType || 'audio/mp4').split(';')[0].trim(),
      fetchedBytes: combined.byteLength,
      totalBytes: rawLen || combined.byteLength
    };
  } catch (e) {
    return null;
  }
}

async function initSaveNowAudioJob(ytId) {
  try {
    const targetYtUrl = `https://www.youtube.com/watch?v=${ytId}`;
    const initUrl = `https://p.savenow.to/ajax/download.php?copyright=0&format=m4a&url=${encodeURIComponent(targetYtUrl)}`;
    const res = await fetch(initUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://loader.to/',
        'Origin': 'https://loader.to'
      },
      signal: AbortSignal.timeout(5500)
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.id) return null;
    let downloadUrl = data.download_url || data.url || null;
    const progressUrl = data.progress_url || `https://p.savenow.to/api/progress?id=${encodeURIComponent(data.id)}`;
    if (!downloadUrl) {
      try {
        const pRes = await fetch(progressUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://loader.to/' },
          signal: AbortSignal.timeout(2000)
        });
        if (pRes.ok) {
          const pData = await pRes.json();
          if (pData && pData.download_url) {
            downloadUrl = pData.download_url;
          }
        }
      } catch (e) {}
    }
    return {
      jobId: data.id,
      progressUrl,
      downloadUrl,
      title: (data.info && data.info.title) || data.title || ''
    };
  } catch (e) {
    return null;
  }
}

function encodeOpaqueAudioToken(rawUrl) {
  if (!rawUrl) return null;
  const str = String(rawUrl).trim();
  if (!str) return null;
  if (str.startsWith('tk_')) return str;
  return 'tk_' + Buffer.from(str, 'utf8').toString('base64url');
}

function decodeOpaqueAudioToken(tokenOrUrl) {
  if (!tokenOrUrl) return '';
  const str = String(tokenOrUrl).trim();
  if (str.startsWith('tk_')) {
    try {
      return Buffer.from(str.slice(3), 'base64url').toString('utf8');
    } catch (e) {
      return '';
    }
  }
  return str;
}

async function checkSaveNowAudioProgress(jobId, rawInternal = false) {
  const cleanId = String(jobId || '').trim();
  if (!cleanId) return { progress: 0, success: 0, download_url: null };
  const pUrl = `https://p.savenow.to/api/progress?id=${encodeURIComponent(cleanId)}`;
  const res = await fetch(pUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://loader.to/',
      'Origin': 'https://loader.to'
    },
    signal: AbortSignal.timeout(5500)
  });
  if (!res.ok) throw new Error(`Progress HTTP ${res.status}`);
  const data = await res.json();
  const rawDl = data.download_url || null;
  return {
    progress: Number(data.progress || 0),
    success: Number(data.success || 0),
    download_url: rawInternal ? rawDl : encodeOpaqueAudioToken(rawDl),
    text: data.text || ''
  };
}

function isAllowedAudioCdnUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return (
      host.endsWith('.savenow.to') ||
      host === 'savenow.to' ||
      host.endsWith('.googlevideo.com') ||
      host.endsWith('.loader.to')
    );
  } catch (e) {
    return false;
  }
}

async function fetchSaveNowAudioChunk(rawDownloadTokenOrUrl, startByte = 0, chunkLen = 1572864, ytId = '') {
  const downloadUrl = decodeOpaqueAudioToken(rawDownloadTokenOrUrl);
  if (!isAllowedAudioCdnUrl(downloadUrl)) {
    throw new Error('Invalid audio stream token');
  }
  const start = Math.max(0, parseInt(startByte, 10) || 0);
  const len = Math.min(2621440, Math.max(65536, parseInt(chunkLen, 10) || 1572864));
  const end = start + len - 1;

  async function doStreamSlice(targetUrl, timeoutMs = 6400) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Referer': 'https://loader.to/',
          'Range': `bytes=${start}-${end}`
        },
        signal: controller.signal
      });
      if (!resp.ok && resp.status !== 206) {
        throw new Error(`Audio CDN HTTP ${resp.status}`);
      }
      const mimeType = String(resp.headers.get('content-type') || 'audio/mp4').split(';')[0].trim().toLowerCase();
      if (mimeType.includes('html')) {
        try { controller.abort(); } catch (e) {}
        return { isHtml: true };
      }

      const isPartial = resp.status === 206;
      let totalBytes = 0;
      if (isPartial) {
        const cr = String(resp.headers.get('content-range') || '');
        const m = cr.match(/\/(\d+)/);
        if (m) totalBytes = parseInt(m[1], 10);
      } else {
        totalBytes = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
      }

      const collected = [];
      let collectedLen = 0;
      let streamOffset = isPartial ? start : 0;
      let reachedEnd = true;

      if (resp.body && typeof resp.body[Symbol.asyncIterator] === 'function') {
        try {
          for await (const rawChunk of resp.body) {
            const chunk = Buffer.from(rawChunk);
            const chunkStart = streamOffset;
            const chunkEnd = streamOffset + chunk.byteLength;
            streamOffset = chunkEnd;

            if (chunkEnd <= start) continue;
            const sliceStart = Math.max(0, start - chunkStart);
            const needed = len - collectedLen;
            const sliceEnd = Math.min(chunk.byteLength, sliceStart + needed);
            if (sliceEnd > sliceStart) {
              const part = chunk.subarray(sliceStart, sliceEnd);
              collected.push(part);
              collectedLen += part.byteLength;
            }
            if (collectedLen >= len) {
              reachedEnd = totalBytes > 0 ? (streamOffset >= totalBytes) : false;
              try { controller.abort(); } catch (e) {}
              break;
            }
          }
        } catch (streamErr) {
          if (collectedLen === 0) throw streamErr;
          reachedEnd = false;
        }
      } else {
        const fullBuf = Buffer.from(await resp.arrayBuffer());
        const part = isPartial ? fullBuf.subarray(0, len) : fullBuf.subarray(start, start + len);
        collected.push(part);
        collectedLen = part.byteLength;
        reachedEnd = isPartial ? (part.byteLength < len) : (start + collectedLen >= fullBuf.byteLength);
      }

      const finalBuf = Buffer.concat(collected);
      if (finalBuf.byteLength < 1200 && finalBuf.toString('utf8', 0, Math.min(64, finalBuf.byteLength)).toLowerCase().includes('<!doctype html')) {
        return { isHtml: true };
      }
      const eof = totalBytes > 0
        ? (start + finalBuf.byteLength >= totalBytes)
        : (reachedEnd && finalBuf.byteLength < len);
      return {
        isHtml: false,
        base64: finalBuf.toString('base64'),
        mimeType,
        start,
        fetchedBytes: finalBuf.byteLength,
        totalBytes: totalBytes || (start + finalBuf.byteLength),
        eof
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  let activeUrl = downloadUrl;
  let res = await doStreamSlice(activeUrl, 6400);
  if (res.isHtml && ytId) {
    const freshJob = await initSaveNowAudioJob(ytId);
    if (freshJob) {
      let freshDl = freshJob.downloadUrl || null;
      for (let i = 0; i < 3 && !freshDl; i++) {
        await new Promise(r => setTimeout(r, 850));
        try {
          const p = await checkSaveNowAudioProgress(freshJob.jobId, true);
          if (p && p.download_url) freshDl = p.download_url;
        } catch (e) {}
      }
      if (freshDl && isAllowedAudioCdnUrl(freshDl)) {
        activeUrl = freshDl;
        res = await doStreamSlice(activeUrl, 5000);
      }
    }
  }

  if (res.isHtml) {
    throw new Error('Audio stream redirect');
  }
  return {
    ...res,
    freshDownloadUrl: activeUrl !== downloadUrl ? encodeOpaqueAudioToken(activeUrl) : undefined
  };
}

async function extractViaInnertube(ytId, preferredLang, visitorData = '') {
  const clients = [
    {
      clientName: 'VISIONOS',
      clientVersion: '1.02',
      clientId: '101',
      deviceMake: 'Apple',
      deviceModel: 'RealityDevice17,1',
      osName: 'visionOS',
      osVersion: '26.5.23O471',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
    },
    {
      clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
      clientVersion: '2.0',
      clientId: '85',
      userAgent: 'Mozilla/5.0 (PlayStation; PlayStation 4/11.50) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Safari/605.1.15',
      isEmbedded: true
    },
    {
      clientName: 'ANDROID_VR',
      clientVersion: '1.65.10',
      clientId: '28',
      androidSdkVersion: 32,
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      osName: 'Android',
      osVersion: '12L',
      userAgent: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip'
    }
  ];

  let meta = { title: '', durationSec: 0, lang: preferredLang };
  let bestAudioFmt = null;
  let bestAudioUa = clients[0].userAgent;

  for (const c of clients) {
    try {
      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': c.userAgent,
        'X-Youtube-Client-Name': c.clientId,
        'X-Youtube-Client-Version': c.clientVersion,
        'Origin': 'https://www.youtube.com',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      };
      if (visitorData) {
        headers['X-Goog-Visitor-Id'] = visitorData;
      }

      const clientContext = {
        clientName: c.clientName,
        clientVersion: c.clientVersion,
        androidSdkVersion: c.androidSdkVersion,
        deviceMake: c.deviceMake,
        deviceModel: c.deviceModel,
        osName: c.osName,
        osVersion: c.osVersion,
        userAgent: c.userAgent,
        hl: 'zh-CN',
        gl: 'US'
      };
      if (visitorData) {
        clientContext.visitorData = visitorData;
      }

      const payloadContext = { client: clientContext };
      if (c.isEmbedded) {
        payloadContext.thirdParty = { embedUrl: 'https://www.youtube.com/' };
      }

      const resp = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          videoId: ytId,
          context: payloadContext
        }),
        signal: AbortSignal.timeout(2000)
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data && data.videoDetails) {
        if (data.videoDetails.title && !meta.title) meta.title = data.videoDetails.title;
        if (data.videoDetails.lengthSeconds && !meta.durationSec) {
          meta.durationSec = parseInt(data.videoDetails.lengthSeconds, 10) || 0;
        }
      }

      if (!bestAudioFmt && data?.streamingData?.adaptiveFormats) {
        const formats = data.streamingData.adaptiveFormats;
        const foundAudio =
          formats.find(f => f.itag === 139 && f.url) ||
          formats.find(f => f.mimeType && f.mimeType.startsWith('audio/mp4') && f.url) ||
          formats.find(f => f.mimeType && f.mimeType.startsWith('audio/') && f.url);
        if (foundAudio) {
          bestAudioFmt = foundAudio;
          bestAudioUa = c.userAgent;
        }
      }

      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (Array.isArray(tracks) && tracks.length > 0) {
        const segs = await fetchBestTrackFromList(tracks, preferredLang);
        if (segs.length > 0) {
          return { meta, segments: segs, audioFmt: bestAudioFmt, audioUa: bestAudioUa };
        }
      }

      if (data?.playabilityStatus?.status === 'OK' && bestAudioFmt) {
        break;
      }
    } catch (e) {}
  }

  return { meta, segments: [], audioFmt: bestAudioFmt, audioUa: bestAudioUa };
}

async function extractViaPipedInstances(ytId, preferredLang) {
  const instances = [
    'https://inv.nadeko.net/api/v1/captions',
    'https://invidious.nerdvpn.de/api/v1/captions'
  ];
  for (const base of instances) {
    try {
      const res = await fetch(`${base}/${ytId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(1800)
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && Array.isArray(data.captions) && data.captions.length > 0) {
        const mapped = data.captions.map(s => ({
          languageCode: s.language_code || s.label || '',
          baseUrl: s.url ? (s.url.startsWith('http') ? s.url : `${base.replace('/api/v1/captions', '')}${s.url}`) : ''
        }));
        const segs = await fetchBestTrackFromList(mapped, preferredLang);
        if (segs.length > 0) return segs;
      }
    } catch (e) {}
  }
  return [];
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

  if (action === 'audio_progress') {
    try {
      const prog = await checkSaveNowAudioProgress(qParams.id || '');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(prog)
      };
    } catch (err) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ progress: 0, success: 0, download_url: null, error: err.message })
      };
    }
  }

  if (action === 'audio_chunk') {
    try {
      const chunkRes = await fetchSaveNowAudioChunk(
        qParams.u || '',
        qParams.start || '0',
        qParams.len || '1572864',
        qParams.ytId || ''
      );
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(chunkRes)
      };
    } catch (err) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: err.message || 'Audio chunk fetch error' })
      };
    }
  }

  const clientIp = (event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'])) || 'anon_ip';
  const now = Date.now();
  const recentReqs = (videoLessonRateLimitMap.get(clientIp) || []).filter(ts => now - ts < 60000);
  if (recentReqs.length >= 120) {
    return {
      statusCode: 429,
      headers,
      body: JSON.stringify({ error: 'Bạn thao tác quá nhanh, vui lòng chờ 1 phút rồi thử lại nhé!' })
    };
  }
  recentReqs.push(now);
  videoLessonRateLimitMap.set(clientIp, recentReqs);

  try {
    let url = '';
    let lang = 'zh';
    let includeAudio = true;
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      url = body.url || '';
      lang = 'zh';
      if (body.includeAudio === false) includeAudio = false;
    } else {
      url = qParams.url || '';
      lang = 'zh';
      if (qParams.includeAudio === '0') includeAudio = false;
    }

    const ytId = extractYouTubeId(url);
    if (!ytId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Đường dẫn YouTube không hợp lệ.' })
      };
    }

    const [oembedData, watchInfo] = await Promise.all([
      fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${ytId}`, { signal: AbortSignal.timeout(2500) })
        .then(r => r.ok ? r.json() : {})
        .catch(() => ({})),
      fetchWatchPageInfo(ytId, lang)
    ]);

    const innerRes = await extractViaInnertube(ytId, lang, watchInfo.visitorData);

    let title = innerRes.meta.title || oembedData.title || `Bài học Video (${ytId})`;
    let durationSec = innerRes.meta.durationSec || watchInfo.durationSec || 0;
    let segments = (innerRes.segments && innerRes.segments.length > 0)
      ? innerRes.segments
      : (watchInfo.segments || []);

    if (segments.length === 0 && !innerRes.audioFmt) {
      segments = await extractViaPipedInstances(ytId, lang);
    }

    const isTooLongNoCc = segments.length === 0 && durationSec > 1800;

    let audioPayload = null;
    let saveNowJob = null;
    if (segments.length === 0 && includeAudio && !isTooLongNoCc) {
      if (innerRes.audioFmt) {
        audioPayload = await downloadAudioFormatInChunks(innerRes.audioFmt, innerRes.audioUa);
      }
      if (!audioPayload) {
        saveNowJob = await initSaveNowAudioJob(ytId);
        if (saveNowJob && saveNowJob.title && (!title || title.startsWith('Bài học Video'))) {
          title = saveNowJob.title;
        }
      }
    }

    const durStr = durationSec > 0
      ? `${String(Math.floor(durationSec / 60)).padStart(2, '0')}:${String(durationSec % 60).padStart(2, '0')}`
      : (segments.length > 0
        ? `${String(Math.floor((segments[segments.length - 1].end || 0) / 60)).padStart(2, '0')}:${String(Math.floor((segments[segments.length - 1].end || 0) % 60)).padStart(2, '0')}`
        : 'Video');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ytId,
        title,
        lang: 'zh',
        duration: durStr,
        durationSec,
        tooLongNoCc: isTooLongNoCc,
        subtitles: segments,
        ...(audioPayload ? {
          audioBase64: audioPayload.base64,
          audioMime: audioPayload.mimeType,
          audioFetchedBytes: audioPayload.fetchedBytes,
          audioTotalBytes: audioPayload.totalBytes
        } : {}),
        ...(saveNowJob ? {
          audioJobId: saveNowJob.jobId,
          audioDownloadUrl: encodeOpaqueAudioToken(saveNowJob.downloadUrl)
        } : {})
      })
    };
  } catch (err) {
    console.error('youtube-lesson error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Không thể tải dữ liệu bài học video lúc này.' })
    };
  }
};

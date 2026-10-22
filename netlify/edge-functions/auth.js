const AUTH_PASSWORD = "0608199417121993";
const AUTH_COOKIE_NAME = "hsk_auth_session";
const AUTH_COOKIE_VALUE = "hsk_sec_token_0608199417121993_ok";
const COOKIE_MAX_AGE = 315360000; // 10 years in seconds

function renderLoginPage(errorMessage = "", statusCode = 401) {
  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Khóa bảo mật</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #f5f0fb 0%, #e8ddf5 50%, #fdfbf7 100%);
      padding: 16px;
      color: #3c2e54;
    }
    .auth-card {
      width: 100%;
      max-width: 360px;
      background: rgba(255, 255, 255, 0.94);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1.5px solid #dfd3ef;
      border-radius: 24px;
      padding: 32px 24px 28px 24px;
      box-shadow: 0 12px 36px rgba(118, 98, 153, 0.16);
      text-align: center;
    }
    .auth-icon {
      font-size: 42px;
      margin-bottom: 12px;
      display: inline-block;
      animation: floatIcon 3s ease-in-out infinite;
    }
    @keyframes floatIcon {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-5px); }
    }
    h1 {
      font-size: 19px;
      font-weight: 800;
      color: #4b3b66;
      margin-bottom: 6px;
    }
    p {
      font-size: 13px;
      color: #766299;
      margin-bottom: 22px;
      line-height: 1.4;
    }
    .auth-input-wrap {
      margin-bottom: 16px;
      position: relative;
    }
    input[type="password"], input[type="text"] {
      width: 100%;
      padding: 13px 16px;
      font-size: 15px;
      border: 1.8px solid #dfd3ef;
      border-radius: 14px;
      outline: none;
      background: #faf7fd;
      color: #2e2042;
      text-align: center;
      letter-spacing: 2px;
      font-weight: 700;
      transition: all 0.2s ease;
    }
    input[type="password"]:focus, input[type="text"]:focus {
      border-color: #8772a8;
      background: #ffffff;
      box-shadow: 0 0 0 4px rgba(135, 114, 168, 0.15);
    }
    button {
      width: 100%;
      padding: 13px;
      font-size: 15px;
      font-weight: 800;
      color: #ffffff;
      background: linear-gradient(135deg, #8772a8 0%, #684e92 100%);
      border: none;
      border-radius: 14px;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(104, 78, 146, 0.3);
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    button:active {
      transform: scale(0.97);
      box-shadow: 0 2px 6px rgba(104, 78, 146, 0.25);
    }
    .error-msg {
      margin-bottom: 16px;
      padding: 8px 12px;
      background: #fdf2f2;
      border: 1px solid #f8b4b4;
      border-radius: 10px;
      color: #c81e1e;
      font-size: 12.5px;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="auth-card">
    <div class="auth-icon">🔒</div>
    <h1>Ứng dụng Học Từ Vựng</h1>
    <p>Trang web này ở chế độ riêng tư.<br>Vui lòng nhập mật khẩu để mở khóa.</p>

    ${errorMessage ? `<div class="error-msg">${errorMessage}</div>` : ''}

    <form method="POST" action="/auth-login" autocomplete="off">
      <div class="auth-input-wrap">
        <input type="text" name="pass" placeholder="Nhập mật khẩu..." autofocus required autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-form-type="other" style="-webkit-text-security: disc; text-security: disc;" />
      </div>
      <button type="submit">Mở khóa ➔</button>
    </form>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: statusCode,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    }
  });
}

export default async (request, context) => {
  const url = new URL(request.url);

  // 1. Logout support: visit /auth-logout
  if (url.pathname === "/auth-logout") {
    return new Response(null, {
      status: 302,
      headers: {
        "Location": "/",
        "Set-Cookie": `${AUTH_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure`
      }
    });
  }

  // 2. Magic Link support: ?pass=... or ?auth=...
  const queryPass = url.searchParams.get("pass") || url.searchParams.get("auth");
  if (queryPass) {
    if (queryPass === AUTH_PASSWORD) {
      url.searchParams.delete("pass");
      url.searchParams.delete("auth");
      const cleanPath = url.pathname + (url.search ? url.search : "");
      return new Response(null, {
        status: 302,
        headers: {
          "Location": cleanPath || "/",
          "Set-Cookie": `${AUTH_COOKIE_NAME}=${AUTH_COOKIE_VALUE}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax; HttpOnly; Secure`
        }
      });
    } else {
      return renderLoginPage("Mật khẩu trong đường dẫn không đúng!", 401);
    }
  }

  // 3. Form POST submission to /auth-login
  if (request.method === "POST" && url.pathname === "/auth-login") {
    try {
      const formData = await request.formData();
      const submittedPass = formData.get("password") || formData.get("pass");
      if (submittedPass === AUTH_PASSWORD) {
        return new Response(null, {
          status: 302,
          headers: {
            "Location": "/",
            "Set-Cookie": `${AUTH_COOKIE_NAME}=${AUTH_COOKIE_VALUE}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax; HttpOnly; Secure`
          }
        });
      } else {
        return renderLoginPage("Mật khẩu không chính xác! Vui lòng thử lại.", 401);
      }
    } catch (_e) {
      return renderLoginPage("Lỗi xử lý yêu cầu!", 400);
    }
  }

  // 4. Always allow PWA installation metadata (manifest, icons, service worker)
  // Chrome & Android WebAPK minting servers fetch manifest.json and icons without session cookies.
  const isPwaPublicFile = /^\/(manifest\.json|icon-192\.png|icon-512\.png|sw\.js)$/i.test(url.pathname);
  if (isPwaPublicFile) {
    return context.next();
  }

  // 5. Validate authentication cookie
  const cookieHeader = request.headers.get("cookie") || "";
  const cookies = cookieHeader.split(";").map(c => c.trim());
  const isAuthenticated = cookies.includes(`${AUTH_COOKIE_NAME}=${AUTH_COOKIE_VALUE}`);

  if (isAuthenticated) {
    // Authenticated! Pass through directly to static assets and serverless functions!
    return context.next();
  }

  // 6. NOT authenticated:
  // For static files (JS, CSS, JSON, media, etc.): return 403 Forbidden!
  const isAsset = /\.(js|css|json|png|jpg|jpeg|gif|webp|svg|ico|otf|ttf|woff|woff2|mp3|mp4|wav)$/i.test(url.pathname);
  if (isAsset) {
    return new Response("403 Forbidden: Access Denied", {
      status: 403,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate"
      }
    });
  }

  // For root or page requests without auth: return the login gate
  return renderLoginPage("", 401);
};

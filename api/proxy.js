const https = require('https');

module.exports = async function handler(req, res) {
  // 允许跨域请求以支持本地开发调试
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  // 安全限制：只允许代理 Airbnb 官方的域名，防止 SSRF 漏洞与恶意请求滥用
  try {
    const parsedUrl = new URL(url);
    if (!parsedUrl.hostname.endsWith('airbnb.com') && !parsedUrl.hostname.endsWith('airbnb.co.jp')) {
      return res.status(400).json({ error: 'Only Airbnb domains are allowed to be proxied.' });
    }
  } catch (urlErr) {
    return res.status(400).json({ error: 'Invalid url format' });
  }

  try {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    }, (proxyRes) => {
      if (proxyRes.statusCode !== 200) {
        return res.status(proxyRes.statusCode).json({ error: `Airbnb returned status ${proxyRes.statusCode}` });
      }

      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      proxyRes.pipe(res);
    }).on('error', (err) => {
      console.error('Proxy request error:', err);
      res.status(500).json({ error: err.message });
    });
  } catch (error) {
    console.error('Proxy handler error:', error);
    res.status(500).json({ error: error.message });
  }
};

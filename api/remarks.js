const { put, list } = require('@vercel/blob');

module.exports = async function handler(req, res) {
  // 设置跨域头以支持本地调试和多域名访问
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    if (req.method === 'GET') {
      // 1. 列出存储的 blob 以定位 remarks.json
      const { blobs } = await list({ prefix: 'remarks.json' });
      if (blobs && blobs.length > 0) {
        // 寻找到精确匹配的 blob
        const targetBlob = blobs.find(b => b.pathname === 'remarks.json') || blobs[0];
        // 用 cache-busting 请求文件内容，防止 CDN 强缓存
        const fileRes = await fetch(targetBlob.url + '?t=' + Date.now());
        if (fileRes.ok) {
          const data = await fileRes.json();
          return res.status(200).json(data);
        }
      }
      // 未找到任何已上传的文件，返回空对象
      return res.status(200).json({});
    }

    if (req.method === 'POST') {
      // 2. 接收前端传入的完整备注 JSON
      const remarksData = req.body;
      if (!remarksData) {
        return res.status(400).json({ error: 'Body is required' });
      }
      
      // 写入并覆盖云端文件，确保 addRandomSuffix 为 false 使其 URL 唯一稳定
      const blob = await put('remarks.json', JSON.stringify(remarksData, null, 2), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true
      });
      
      return res.status(200).json({ success: true, url: blob.url });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Vercel Blob 读写错误:', error);
    return res.status(500).json({ error: error.message });
  }
};

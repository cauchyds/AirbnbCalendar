const { put, list } = require('@vercel/blob');
const { BRANDS_CONFIG } = require('../config');

module.exports = async function handler(req, res) {
  // 设置跨域头以支持本地调试和多端调用
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 校验 Vercel Blob 密钥是否存在，避免抛出底层 SDK 错误
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({
      error: '数据库云端密钥 (BLOB_READ_WRITE_TOKEN) 未设置。请参考使用说明，在 Vercel 控制台中的 Settings -> Environment Variables 页面添加此变量并重新部署！'
    });
  }

  try {
    if (req.method === 'GET') {
      // 1. 列出存储的 blob 以定位 config.json
      const { blobs } = await list({ prefix: 'config.json' });
      if (blobs && blobs.length > 0) {
        const targetBlob = blobs.find(b => b.pathname === 'config.json') || blobs[0];
        // 请求并解析 config.json 配置文件内容，带 cache-busting 避免 CDN 强缓存
        const fileRes = await fetch(targetBlob.url + '?t=' + Date.now());
        if (fileRes.ok) {
          const data = await fileRes.json();
          return res.status(200).json(data);
        }
      }
      // 如果云端还没有配置过文件，则降级返回本地 config.js 中的默认 BRANDS_CONFIG
      return res.status(200).json(BRANDS_CONFIG);
    }

    if (req.method === 'POST') {
      // 2. 接收并保存前端传入的新配置数据
      const newConfig = req.body;
      if (!newConfig || !Array.isArray(newConfig)) {
        return res.status(400).json({ error: 'Body must be an array of brands' });
      }
      
      const blob = await put('config.json', JSON.stringify(newConfig, null, 2), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true
      });
      
      return res.status(200).json({ success: true, url: blob.url });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Vercel Blob 配置读写错误:', error);
    return res.status(500).json({ error: error.message });
  }
};

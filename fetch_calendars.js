/**
 * Node.js 房源日历抓取与解析脚本 (fetch_calendars.js)
 * 
 * 此脚本采用 Node.js 原生 `https` 模块，无需依赖任何第三方库（如 axios、node-fetch、ical 等），
 * 确保在 GitHub Actions 的虚拟环境中能够以零配置、极速且 100% 成功地运行。
 */

const fs = require('fs');
const https = require('https');
const path = require('path');
const { BRANDS_CONFIG } = require('./config');

// 封装 HTTPS GET 请求为 Promise
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`请求失败，状态码: ${res.statusCode} URL: ${url}`));
        return;
      }
      
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { resolve(data); });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

// 解析日期字符串为 YYYY-MM-DD
function parseDateString(val) {
  const cleanVal = val.replace(/^VALUE=DATE:/, '');
  if (cleanVal.length >= 8) {
    const y = cleanVal.substring(0, 4);
    const m = cleanVal.substring(4, 6);
    const d = cleanVal.substring(6, 8);
    return `${y}-${m}-${d}`;
  }
  return cleanVal;
}

// 解析 ICS 文件纯文本为结构化事件列表
function parseICS(icsText) {
  const events = [];
  const lines = icsText.split(/\r?\n/);
  let currentEvent = null;
  
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    
    // 处理 iCal 换行折叠（前导为空格或制表符代表上一行的延续）
    while (i + 1 < lines.length && (lines[i+1].startsWith(' ') || lines[i+1].startsWith('\t'))) {
      line += lines[i+1].substring(1);
      i++;
    }
    
    line = line.trim();
    if (line === 'BEGIN:VEVENT') {
      currentEvent = {};
    } else if (line === 'END:VEVENT') {
      if (currentEvent && currentEvent.start && currentEvent.end) {
        currentEvent.isReservation = !!(currentEvent.reservationUrl || (currentEvent.description && currentEvent.description.includes('Reservation URL')));
        events.push(currentEvent);
      }
      currentEvent = null;
    } else if (currentEvent) {
      // 匹配 key 及其参数和 value
      const match = line.match(/^([^;:]+)(?:;[^:]+)?:(.*)$/);
      if (match) {
        const key = match[1];
        const value = match[2];
        
        if (key === 'DTSTART') {
          currentEvent.start = parseDateString(value);
        } else if (key === 'DTEND') {
          currentEvent.end = parseDateString(value);
        } else if (key === 'SUMMARY') {
          currentEvent.summary = value;
        } else if (key === 'DESCRIPTION') {
          currentEvent.description = value;
          
          // 提取电话后四位
          const phoneMatch = value.match(/Phone Number \(Last 4 Digits\): (\d{4})/i);
          if (phoneMatch) {
            currentEvent.phoneLast4 = phoneMatch[1];
          }
          
          // 提取订单详情 URL（将换行转义符去掉）
          const urlMatch = value.match(/Reservation URL: (https:\/\/\S+)/i);
          if (urlMatch) {
            currentEvent.reservationUrl = urlMatch[1].replace(/\\n/g, '').trim();
          }
        } else if (key === 'UID') {
          currentEvent.uid = value;
        }
      }
    }
  }
  return events;
}

// 主同步执行逻辑
async function main() {
  console.log('--- 🏮 开始抓取 Airbnb 房源日历 ---');
  const syncTimestamp = new Date().toISOString();
  const results = {
    lastUpdated: syncTimestamp,
    properties: {}
  };

  // 展开所有需要抓取的房源
  const fetchTasks = [];
  for (const brand of BRANDS_CONFIG) {
    for (const prop of brand.properties) {
      if (prop.ical) {
        fetchTasks.push({
          brandId: brand.id,
          brandName: brand.name,
          propId: prop.id,
          propName: prop.name,
          ical: prop.ical
        });
      } else {
        console.log(`⚠️ 房源 [${brand.name} - ${prop.name}] 未配置 ical 链接，跳过。`);
        results.properties[prop.id] = {
          propId: prop.id,
          propName: prop.name,
          brandId: brand.id,
          events: [],
          status: 'no_link'
        };
      }
    }
  }

  // 并发抓取和解析
  console.log(`正在并发请求 ${fetchTasks.length} 个 iCal 数据源...`);
  const promises = fetchTasks.map(async (task) => {
    try {
      console.log(`⏳ 正在拉取 [${task.brandName} - ${task.propName}]...`);
      const icsData = await fetchUrl(task.ical);
      const events = parseICS(icsData);
      
      console.log(`✅ 成功解析 [${task.brandName} - ${task.propName}]: 找到 ${events.length} 个预订日程`);
      results.properties[task.propId] = {
        propId: task.propId,
        propName: task.propName,
        brandId: task.brandId,
        events: events,
        status: 'ok'
      };
    } catch (error) {
      console.error(`❌ 拉取 [${task.brandName} - ${task.propName}] 失败:`, error.message);
      results.properties[task.propId] = {
        propId: task.propId,
        propName: task.propName,
        brandId: task.brandId,
        events: [],
        status: 'error',
        errorMessage: error.message
      };
    }
  });

  await Promise.all(promises);

  // 写入 JSON 静态数据文件
  const outputFilePath = path.join(__dirname, 'data.json');
  fs.writeFileSync(outputFilePath, JSON.stringify(results, null, 2), 'utf8');
  
  console.log('\n--- 🎉 日历同步圆满完成 ---');
  console.log(`静态数据已成功写入: ${outputFilePath}`);
  console.log(`总同步房源数: ${Object.keys(results.properties).length}`);
  console.log(`同步时间: ${syncTimestamp}`);
}

main().catch(err => {
  console.error('💥 抓取任务发生未捕获异常:', err);
  process.exit(1);
});

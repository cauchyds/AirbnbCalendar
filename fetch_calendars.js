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
// 判断事件是否为有效的客人预订（而非房东/系统锁房）
function isReservationEvent(ev) {
  if (!ev) return false;
  
  const desc = (ev.description || '').trim();
  if (ev.reservationUrl || desc.includes('Reservation URL') || desc.includes('预订链接') || desc.includes('预订URL')) {
    return true;
  }
  
  const summary = (ev.summary || '').trim();
  if (!summary) {
    return false;
  }
  
  const summaryLower = summary.toLowerCase();
  const isBlock = summaryLower.includes('not available') || 
                  summaryLower.includes('unavailable') || 
                  summaryLower.includes('blocked') || 
                  summaryLower.includes('closed') ||
                  summaryLower.includes('锁房') || 
                  summaryLower.includes('锁定') || 
                  summaryLower.includes('不可用') ||
                  summaryLower.includes('准备时间') ||
                  summaryLower.includes('preparation time') ||
                  summaryLower.includes('装修') ||
                  summaryLower.includes('自用') ||
                  summaryLower.includes('自住') ||
                  summaryLower.includes('保洁') ||
                  summaryLower.includes('clean');
                  
  return !isBlock;
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
        currentEvent.isReservation = isReservationEvent(currentEvent);
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
          
          // 提取订单详情 URL（过滤掉换行转义符及后续内容）
          const urlMatch = value.match(/Reservation URL: (https:\/\/[^\s\\]+)/i);
          if (urlMatch) {
            currentEvent.reservationUrl = urlMatch[1].trim();
          }
        } else if (key === 'UID') {
          currentEvent.uid = value;
        }
      }
    }
  }
  return events;
}

// 获取东京（日本）时间的今天日期 (YYYY-MM-DD)
function getTodayString() {
  const d = new Date();
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(d);
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  return `${year}-${month}-${day}`;
}

// 合并新旧日历事件，保留已经发生的历史数据，更新未来的数据
function mergeCalendarEvents(oldEvents = [], newEvents = []) {
  const todayStr = getTodayString();
  const merged = [];
  
  const newEventUids = new Set(newEvents.map(e => e.uid).filter(Boolean));
  const newEventKeys = new Set(newEvents.map(e => `${e.start}_${e.end}_${e.summary}`));
  
  // 1. 处理旧事件
  oldEvents.forEach(oldEv => {
    const isPast = oldEv.end < todayStr;
    
    if (isPast) {
      // 历史数据：保留
      const matchesNewUid = oldEv.uid && newEventUids.has(oldEv.uid);
      const matchesNewKey = newEventKeys.has(`${oldEv.start}_${oldEv.end}_${oldEv.summary}`);
      
      if (!matchesNewUid && !matchesNewKey) {
        merged.push(oldEv);
      }
    }
  });
  
  // 2. 加入所有新拉取到的事件
  newEvents.forEach(newEv => {
    merged.push(newEv);
  });
  
  // 3. 去重
  const finalEvents = [];
  const seenUids = new Set();
  const seenKeys = new Set();
  
  merged.forEach(ev => {
    const key = `${ev.start}_${ev.end}_${ev.summary}`;
    if (ev.uid) {
      if (!seenUids.has(ev.uid)) {
        seenUids.add(ev.uid);
        seenKeys.add(key);
        finalEvents.push(ev);
      }
    } else {
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        finalEvents.push(ev);
      }
    }
  });
  
  return finalEvents;
}

// 主同步执行逻辑
async function main() {
  console.log('--- 🏮 开始抓取 Airbnb 房源日历 ---');
  const syncTimestamp = new Date().toISOString();
  
  // 0. 从 Vercel API 动态加载最新的房源配置 (实现全自动数据库驱动)
  const CONFIG_API_URL = process.env.CONFIG_API_URL || 'https://airbnb-calendar-cauchyds.vercel.app/api/config';
  let brandsConfig = BRANDS_CONFIG;
  try {
    console.log(`⏳ 正在尝试从云端获取最新房源配置: ${CONFIG_API_URL}`);
    const configDataStr = await fetchUrl(CONFIG_API_URL);
    const parsedConfig = JSON.parse(configDataStr);
    if (parsedConfig && Array.isArray(parsedConfig) && parsedConfig.length > 0) {
      brandsConfig = parsedConfig;
      console.log('✅ 成功从云端加载最新房源配置，包含房源数:', brandsConfig.flatMap(b => b.properties).length);
    }
  } catch (e) {
    console.warn('⚠️ 从云端加载配置失败，将降级使用本地默认 config.js 配置:', e.message);
  }

  // 1. 读取原有的 data.json 数据用于合并历史数据
  const outputFilePath = path.join(__dirname, 'data.json');
  let oldData = null;
  if (fs.existsSync(outputFilePath)) {
    try {
      oldData = JSON.parse(fs.readFileSync(outputFilePath, 'utf8'));
      console.log('⚙️ 成功载入本地旧 data.json 历史缓存');
    } catch (e) {
      console.warn('⚠️ 读取旧 data.json 失败或文件格式损坏:', e.message);
    }
  }

  const results = {
    lastUpdated: syncTimestamp,
    properties: {}
  };

  // 展开所有需要抓取的房源
  const fetchTasks = [];
  for (const brand of brandsConfig) {
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
      
      const existingProp = oldData && oldData.properties && oldData.properties[task.propId];
      const existingEvents = existingProp ? existingProp.events : [];
      const mergedEvents = mergeCalendarEvents(existingEvents, events);
      
      results.properties[task.propId] = {
        propId: task.propId,
        propName: task.propName,
        brandId: task.brandId,
        events: mergedEvents,
        status: 'ok'
      };
    } catch (error) {
      console.error(`❌ 拉取 [${task.brandName} - ${task.propName}] 失败:`, error.message);
      
      const existingProp = oldData && oldData.properties && oldData.properties[task.propId];
      const existingEvents = existingProp ? existingProp.events : [];
      
      results.properties[task.propId] = {
        propId: task.propId,
        propName: task.propName,
        brandId: task.brandId,
        events: existingEvents,
        status: 'error',
        errorMessage: error.message
      };
    }
  });

  await Promise.all(promises);

  // 写入 JSON 静态数据文件
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

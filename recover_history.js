/**
 * 历史数据挽回脚本 (recover_history.js)
 * 
 * 作用：从项目的 Git 提交历史中提取历史上所有已被 Airbnb 自动清理的过期预订日程，
 * 并应用“增量合并与去重”策略整合回当前的 data.json 中。
 * 
 * 使用方法：在根目录下直接执行 `node recover_history.js`。
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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

async function main() {
  console.log('=== 📅 开始执行 Git 日历历史预订数据挽回 ===');
  
  const repoPath = __dirname;
  const dataFilePath = path.join(repoPath, 'data.json');
  
  // 1. 获取当前最新（本地）的 data.json 作为基底
  let currentData = { lastUpdated: new Date().toISOString(), properties: {} };
  if (fs.existsSync(dataFilePath)) {
    try {
      currentData = JSON.parse(fs.readFileSync(dataFilePath, 'utf8'));
      console.log('✅ 成功载入当前本地最新的 data.json');
    } catch (e) {
      console.error('❌ 本地 data.json 解析失败，退出。', e.message);
      process.exit(1);
    }
  } else {
    console.warn('⚠️ 未找到本地 data.json，将创建一个全新文件。');
  }

  // 2. 获取 data.json 的所有 Git 历史提交 hash 列表
  let commits = [];
  try {
    const logOutput = execSync('git log --format="%H" -- data.json', { cwd: repoPath, encoding: 'utf8' });
    commits = logOutput.split('\n').map(c => c.trim()).filter(Boolean);
    console.log(`📦 共发现 ${commits.length} 次涉及 data.json 的提交记录`);
  } catch (e) {
    console.error('❌ 获取 Git 提交历史失败！请确保是在 Git 仓库目录下运行此脚本。', e.message);
    process.exit(1);
  }

  if (commits.length === 0) {
    console.log('📅 没有找到任何 Git 历史提交，无需合并历史。');
    return;
  }

  const todayStr = getTodayString();
  console.log(`🇯🇵 东京时区今日日期: ${todayStr}`);
  
  // 存储最终融合后的所有房源事件表 (propId -> Map(uid/key -> event))
  const finalPropertiesEvents = {};
  
  // 3. 首先把本地现有的全部事件载入 Map（表示这是最权威、最即时的状态）
  for (const [propId, prop] of Object.entries(currentData.properties || {})) {
    finalPropertiesEvents[propId] = new Map();
    (prop.events || []).forEach(ev => {
      const key = ev.uid || `${ev.start}_${ev.end}_${ev.summary}`;
      finalPropertiesEvents[propId].set(key, ev);
    });
  }

  // 4. 从最老的提交向最新的提交顺序处理，这样历史事件就能逐步补齐
  const reversedCommits = [...commits].reverse();
  let recoveredCountTotal = 0;
  
  console.log('⏳ 正在逐个提交提取历史事件，请稍候...');
  for (const commit of reversedCommits) {
    try {
      const fileContent = execSync(`git show ${commit}:data.json`, { cwd: repoPath, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' });
      const data = JSON.parse(fileContent);
      
      for (const [propId, prop] of Object.entries(data.properties || {})) {
        if (!finalPropertiesEvents[propId]) {
          finalPropertiesEvents[propId] = new Map();
        }
        
        (prop.events || []).forEach(ev => {
          const key = ev.uid || `${ev.start}_${ev.end}_${ev.summary}`;
          const isPast = ev.end < todayStr;
          
          if (isPast) {
            // 如果是历史上的预订，且最终集合中还不存在，说明已被自动清理，需要予以挽回！
            if (!finalPropertiesEvents[propId].has(key)) {
              finalPropertiesEvents[propId].set(key, ev);
              recoveredCountTotal++;
            }
          } else {
            // 未来预订：如果最终集合中目前不存在，则可以作为补充（比如已被删除但之前确实存在过）
            // 但如果最终集合中存在（说明最新拉取有最新房态），以最新拉取到的状态为绝对准则。
            if (!finalPropertiesEvents[propId].has(key)) {
              finalPropertiesEvents[propId].set(key, ev);
            }
          }
        });
      }
    } catch (e) {
      // 忽略部分过旧的提交或格式不兼容的解析错误
    }
  }

  console.log(`🎉 历史数据恢复处理完毕！共挽回已擦除历史预订: ${recoveredCountTotal} 条`);

  // 5. 组装最终结果写回 data.json
  const finalProperties = {};
  for (const [propId, eventsMap] of Object.entries(finalPropertiesEvents)) {
    const currentProp = currentData.properties[propId] || {
      propId: propId,
      propName: propId,
      status: 'ok'
    };
    
    // 将 Map 转换为数组并按照日期排序，使得日历排列有序
    const sortedEvents = Array.from(eventsMap.values()).sort((a, b) => {
      return a.start.localeCompare(b.start);
    });

    finalProperties[propId] = {
      ...currentProp,
      events: sortedEvents
    };
  }

  const updatedData = {
    ...currentData,
    lastUpdated: new Date().toISOString(),
    properties: finalProperties
  };

  fs.writeFileSync(dataFilePath, JSON.stringify(updatedData, null, 2), 'utf8');
  console.log(`💾 成功写入更新后的 data.json，路径: ${dataFilePath}`);
  console.log('=== 🌸 数据挽回大功告成 ===\n');
}

main().catch(err => {
  console.error('💥 挽回脚本发生异常:', err);
  process.exit(1);
});

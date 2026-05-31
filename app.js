/**
 * 雲町屋 & 多品牌房源日历看板 - 核心交互与重构渲染逻辑 (app.js)
 * 
 * 核心功能：
 * 1. 初始化 Tab 并提供多品牌筛选联动
 * 2. 双轨数据加载：读取 data.json -> 缓存 -> 客户端 CORS 代理实时获取
 * 3. 房态决策系统：计算任意日期下房源是 空闲/预订/入住/退房/半格交接 状态
 * 4. 🔄 [重构] 纵向瀑布流甘特图 (Y-轴为日期，X-轴为房源列)
 * 5. 📋 [新增] 每日 8 行子格编译引擎 (第 1 行为房态，第 2-8 行为备忘录备注)
 * 6. 💾 [新增] LocalStorage 本地备忘录持久化读写与分类标签渲染
 * 7. 动态绘制单房源月历卡片与统计分析
 * 8. 提供房态预订详情模态框 与 运营备注编辑模态框
 */

// ==========================================================================
// 1. 全局状态管理 (Application State)
// ==========================================================================
const state = {
  currentBrandId: 'yunmachiya', // 当前选中的品牌，'all' 代表所有品牌
  timelineStartDate: null,      // 甘特图起始日期 (Date 对象)
  timelineScale: 30,            // 甘特图展示跨度 (15, 30, 60 天，默认为 30天)
  selectedPropertyId: '',       // 单日历当前选中房源
  calendarYear: null,           // 单日历当前年份
  calendarMonth: null,          // 单日历当前月份 (0-11)
  
  // 核心房态数据源
  lastUpdated: null,
  propertiesData: {},           // 键为 propId，值为 { propId, propName, brandId, events: [...] }
  rawConfig: BRANDS_CONFIG,     // 来自 config.js
  
  // 备忘录/任务数据 (持久化于 localStorage)
  remarksData: {},              // 键为 "YYYY-MM-DD_propId_slotIdx" (slotIdx 1-7对应子行2-8)
  
  // 当前处于活动编辑中的备注信息
  remarksActivePropId: '',
  remarksActiveDate: '',
  remarksActiveSlotIdx: 0,
  remarksActiveTag: ''          // 选中的快捷标签 (🔧 维修, 🚒 消防...)
};

// CORS 代理服务列表，备用切换提高可用性
const CORS_PROXIES = [
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
];

// ==========================================================================
// 2. 日期与文本工具函数 (Utility Functions)
// ==========================================================================
function getTodayString() {
  const d = new Date();
  return formatDateString(d);
}

function formatDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

// 计算两日期之间的晚数
function getNights(startStr, endStr) {
  const start = new Date(startStr);
  const end = new Date(endStr);
  const diffTime = Math.abs(end - start);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

// 获取某年某月的天数
function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

// 格式化日期中文展示 (如：2026年06月02日)
function formatDateChinese(dateStr) {
  if (!dateStr) return '-';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  return `${parts[0]}年${parseInt(parts[1])}月${parseInt(parts[2])}日`;
}

// 安全 HTML 转义，防止备注 XSS 并保证数据呈现安全
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ==========================================================================
// 3. iCal (ICS) 客户端解析器 (Client-side ICS Parser)
// ==========================================================================
function parseICSClient(icsText) {
  const events = [];
  const lines = icsText.split(/\r?\n/);
  let currentEvent = null;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    
    // 处理 iCal 折行
    while (i + 1 < lines.length && (lines[i+1].startsWith(' ') || lines[i+1].startsWith('\t'))) {
      line += lines[i+1].substring(1);
      i++;
    }
    
    line = line.trim();
    if (line === 'BEGIN:VEVENT') {
      currentEvent = {};
    } else if (line === 'END:VEVENT') {
      if (currentEvent && currentEvent.start && currentEvent.end) {
        events.push(currentEvent);
      }
      currentEvent = null;
    } else if (currentEvent) {
      const match = line.match(/^([^;:]+)(?:;[^:]+)?:(.*)$/);
      if (match) {
        const key = match[1];
        const value = match[2];
        
        if (key === 'DTSTART') {
          currentEvent.start = parseICSDateVal(value);
        } else if (key === 'DTEND') {
          currentEvent.end = parseICSDateVal(value);
        } else if (key === 'SUMMARY') {
          currentEvent.summary = value;
        } else if (key === 'DESCRIPTION') {
          currentEvent.description = value;
          const phoneMatch = value.match(/Phone Number \(Last 4 Digits\): (\d{4})/i);
          if (phoneMatch) currentEvent.phoneLast4 = phoneMatch[1];
          
          const urlMatch = value.match(/Reservation URL: (https:\/\/\S+)/i);
          if (urlMatch) currentEvent.reservationUrl = urlMatch[1].replace(/\\n/g, '').trim();
        } else if (key === 'UID') {
          currentEvent.uid = value;
        }
      }
    }
  }
  return events;
}

function parseICSDateVal(val) {
  const cleanVal = val.replace(/^VALUE=DATE:/, '');
  if (cleanVal.length >= 8) {
    const y = cleanVal.substring(0, 4);
    const m = cleanVal.substring(4, 6);
    const d = cleanVal.substring(6, 8);
    return `${y}-${m}-${d}`;
  }
  return cleanVal;
}

// ==========================================================================
// 4. 房态决策系统 (Daily Booking Classifier)
// ==========================================================================
/**
 * 核心决策算法：根据日期计算特定房源的今日房态
 * 返回：{ status: 'vacant' | 'checkin' | 'checkout' | 'reserved' | 'split-out-in', event, checkOutEvent, checkInEvent }
 */
function getPropertyStatusForDate(propId, dateStr) {
  const prop = state.propertiesData[propId];
  if (!prop || !prop.events) return { status: 'vacant' };
  
  let isCheckIn = false;
  let isCheckOut = false;
  let isBetween = false;
  
  let checkInEvent = null;
  let checkOutEvent = null;
  let activeEvent = null;
  
  for (const ev of prop.events) {
    // 恰好今天入住
    if (ev.start === dateStr) {
      isCheckIn = true;
      checkInEvent = ev;
    }
    // 恰好今天退房
    if (ev.end === dateStr) {
      isCheckOut = true;
      checkOutEvent = ev;
    }
    // 今天处于订单之间（夜间驻留）
    // 按照酒店/民宿标准，入住第一晚开始计算，退房当天中午结束
    if (dateStr >= ev.start && dateStr < ev.end) {
      isBetween = true;
      activeEvent = ev;
    }
  }
  
  // 核心：若上午有客人退房，下午有客人入住，则属于半格斜切（前退后入）
  if (isCheckIn && isCheckOut) {
    return { status: 'split-out-in', checkOutEvent, checkInEvent };
  }
  if (isCheckIn) {
    return { status: 'checkin', event: checkInEvent };
  }
  if (isCheckOut) {
    return { status: 'checkout', event: checkOutEvent };
  }
  if (isBetween) {
    return { status: 'reserved', event: activeEvent };
  }
  
  return { status: 'vacant' };
}

// ==========================================================================
// 5. 数据源拉取与本地备注加载 (Data Loaders & Remarks Loader)
// ==========================================================================
async function loadData() {
  showSyncButtonLoading(true);
  
  // A. 载入本地备忘录数据
  state.remarksData = JSON.parse(localStorage.getItem('airbnb_calendar_remarks')) || {};
  
  // B. 尝试从 localStorage 优先读取本地缓存，加快二次访问速度
  const cachedData = localStorage.getItem('airbnb_calendar_data');
  if (cachedData) {
    try {
      const parsed = JSON.parse(cachedData);
      const cacheTime = new Date(parsed.lastUpdated);
      // 20分钟内有效
      if (new Date() - cacheTime < 20 * 60 * 1000) {
        console.log('🚀 命中本地有效缓存数据');
        applyData(parsed);
        showSyncButtonLoading(false);
        return;
      }
    } catch (e) {
      localStorage.removeItem('airbnb_calendar_data');
    }
  }

  // C. 读取静态 data.json
  try {
    const response = await fetch('data.json?t=' + new Date().getTime());
    if (!response.ok) throw new Error('读取静态日历 JSON 失败');
    const data = await response.json();
    console.log('✅ 成功从静态 data.json 获取最新日程');
    localStorage.setItem('airbnb_calendar_data', JSON.stringify(data));
    applyData(data);
  } catch (error) {
    console.warn('⚠️ 静态 data.json 加载失败或尚不存在，启动前端多路并发拉取备份机制...', error);
    await fetchLiveSyncFallback();
  }
  
  showSyncButtonLoading(false);
}

// 客户端直连抓取备用机制（通过公共跨域代理）
async function fetchLiveSyncFallback(useProxyIndex = 0) {
  if (useProxyIndex >= CORS_PROXIES.length) {
    alert('❌ 所有 CORS 跨域代理服务器均响应超时或被拒绝，请稍后再试，或等待 GitHub Actions 后台同步。');
    return;
  }
  
  const proxy = CORS_PROXIES[useProxyIndex];
  console.log(`⏳ 正在使用 CORS 代理 [${useProxyIndex}] 实时获取 16 个房源 iCal...`);
  
  const syncTimestamp = new Date().toISOString();
  const fallbackResults = {
    lastUpdated: syncTimestamp,
    properties: {}
  };
  
  const fetchTasks = [];
  for (const brand of state.rawConfig) {
    for (const prop of brand.properties) {
      if (prop.ical) {
        fetchTasks.push({ brandId: brand.id, propId: prop.id, propName: prop.name, ical: prop.ical });
      } else {
        fallbackResults.properties[prop.id] = { propId: prop.id, propName: prop.name, brandId: brand.id, events: [], status: 'no_link' };
      }
    }
  }
  
  const promises = fetchTasks.map(async (task) => {
    try {
      const proxiedUrl = proxy(task.ical);
      const res = await fetch(proxiedUrl);
      if (!res.ok) throw new Error(`状态码: ${res.status}`);
      const text = await res.text();
      const events = parseICSClient(text);
      fallbackResults.properties[task.propId] = {
        propId: task.propId,
        propName: task.propName,
        brandId: task.brandId,
        events: events,
        status: 'ok'
      };
    } catch (e) {
      console.error(`⚠️ 代理抓取房源 [${task.propName}] 失败:`, e.message);
      fallbackResults.properties[task.propId] = {
        propId: task.propId,
        propName: task.propName,
        brandId: task.brandId,
        events: [],
        status: 'error',
        errorMessage: e.message
      };
    }
  });
  
  try {
    await Promise.all(promises);
    console.log('🎉 客户端跨域多路并发实时同步顺利完成');
    localStorage.setItem('airbnb_calendar_data', JSON.stringify(fallbackResults));
    applyData(fallbackResults);
  } catch (err) {
    console.error('💥 备用拉取任务出错，尝试切换下一个 CORS 代理...', err);
    await fetchLiveSyncFallback(useProxyIndex + 1);
  }
}

// 应用并激活拉取到的数据
function applyData(data) {
  state.lastUpdated = data.lastUpdated;
  state.propertiesData = data.properties;
  
  const timeString = new Date(state.lastUpdated).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  document.getElementById('sync-time-string').innerText = timeString;
  
  renderBrandTabs();
  switchBrand(state.currentBrandId);
}

function showSyncButtonLoading(loading) {
  const btn = document.getElementById('btn-manual-sync');
  const icon = btn.querySelector('.sync-icon');
  if (loading) {
    btn.disabled = true;
    icon.classList.add('sync-icon-spin');
  } else {
    btn.disabled = false;
    icon.classList.remove('sync-icon-spin');
  }
}

// ==========================================================================
// 6. UI 品牌切换控制 (Brand Navigation)
// ==========================================================================
function renderBrandTabs() {
  const container = document.getElementById('brand-tabs');
  container.innerHTML = '';
  
  state.rawConfig.forEach(brand => {
    const button = document.createElement('button');
    button.className = `brand-tab ${state.currentBrandId === brand.id ? 'active' : ''}`;
    button.innerHTML = `${brand.icon} ${brand.name}`;
    button.onclick = () => switchBrand(brand.id);
    container.appendChild(button);
  });
  
  const allButton = document.createElement('button');
  allButton.className = `brand-tab ${state.currentBrandId === 'all' ? 'active' : ''}`;
  allButton.innerHTML = `🌐 混合总览`;
  allButton.onclick = () => switchBrand('all');
  container.appendChild(allButton);
}

function switchBrand(brandId) {
  state.currentBrandId = brandId;
  
  const tabs = document.querySelectorAll('.brand-tab');
  tabs.forEach((tab, index) => {
    const isAllTab = index === state.rawConfig.length;
    const currentId = isAllTab ? 'all' : state.rawConfig[index].id;
    if (currentId === brandId) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });
  
  const activeProps = getPropertiesForActiveBrand();
  
  renderKPISummary(activeProps);
  renderDailyTodoList(activeProps);
  
  // 🔄 重构核心：渲染对调后的纵向瀑布流甘特图 (X轴为房源列，Y轴为日期行)
  renderGanttTimeline(activeProps);
  
  populatePropertyDropdown(activeProps);
}

function getPropertiesForActiveBrand() {
  if (state.currentBrandId === 'all') {
    let allProps = [];
    state.rawConfig.forEach(b => {
      allProps = allProps.concat(b.properties);
    });
    return allProps;
  } else {
    const brand = state.rawConfig.find(b => b.id === state.currentBrandId);
    return brand ? brand.properties : [];
  }
}

// ==========================================================================
// 7. 大盘 KPI 与待办事项渲染
// ==========================================================================
function renderKPISummary(activeProps) {
  const total = activeProps.length;
  document.getElementById('kpi-total-properties').innerText = total;
  
  const todayStr = getTodayString();
  let checkInsCount = 0;
  let checkOutsCount = 0;
  let occupiedCount = 0;
  
  activeProps.forEach(p => {
    const fStatus = getPropertyStatusForDate(p.id, todayStr);
    const s = fStatus.status;
    
    if (s === 'split-out-in') {
      checkInsCount++;
      checkOutsCount++;
      occupiedCount++;
    } else if (s === 'checkin') {
      checkInsCount++;
      occupiedCount++;
    } else if (s === 'checkout') {
      checkOutsCount++;
    } else if (s === 'reserved') {
      occupiedCount++;
    }
  });
  
  document.getElementById('kpi-today-checkins').innerText = checkInsCount;
  document.getElementById('kpi-today-checkouts').innerText = checkOutsCount;
  
  const rate = total > 0 ? Math.round((occupiedCount / total) * 100) : 0;
  document.getElementById('kpi-occupancy-rate').innerText = `${rate}%`;
}

function renderDailyTodoList(activeProps) {
  const todayStr = getTodayString();
  const listCheckin = document.getElementById('list-today-checkins');
  const listCheckout = document.getElementById('list-today-checkouts');
  
  listCheckin.innerHTML = '';
  listCheckout.innerHTML = '';
  
  let hasIn = false;
  let hasOut = false;
  
  activeProps.forEach(p => {
    const fStatus = getPropertyStatusForDate(p.id, todayStr);
    const s = fStatus.status;
    
    if (s === 'checkin' || s === 'split-out-in') {
      hasIn = true;
      const ev = s === 'checkin' ? fStatus.event : fStatus.checkInEvent;
      const card = createTodoCard(p.name, ev, 'checkin');
      listCheckin.appendChild(card);
    }
    
    if (s === 'checkout' || s === 'split-out-in') {
      hasOut = true;
      const ev = s === 'checkout' ? fStatus.event : fStatus.checkOutEvent;
      const card = createTodoCard(p.name, ev, 'checkout');
      listCheckout.appendChild(card);
    }
  });
  
  if (!hasIn) listCheckin.innerHTML = '<div class="todo-empty">🏮 今日无新入住客房</div>';
  if (!hasOut) listCheckout.innerHTML = '<div class="todo-empty">🧹 今日无退房保洁日程</div>';
}

function createTodoCard(propertyName, event, type) {
  const item = document.createElement('div');
  item.className = 'todo-item';
  const nights = getNights(event.start, event.end);
  
  item.innerHTML = `
    <div class="todo-item-info">
      <span class="todo-prop-name">${propertyName}</span>
      <span class="todo-dates">${formatDateChinese(event.start)} 至 ${formatDateChinese(event.end)}</span>
    </div>
    <div class="todo-item-meta">
      <span class="todo-nights">${nights}晚</span>
      <span class="btn-todo-details">查看详情</span>
    </div>
  `;
  
  item.querySelector('.btn-todo-details').onclick = () => {
    showBookingModal(propertyName, type === 'checkin' ? '今日新入住' : '今日退房', event);
  };
  return item;
}

function getBrandNameForProperty(propName) {
  for (const b of state.rawConfig) {
    if (b.properties.find(p => p.name === propName)) {
      return b.name;
    }
  }
  return '所有房源';
}

// ==========================================================================
// 8. 🔄 瀑布流甘特图渲染核心 (swapped axis & 8 rows daily renderer)
// ==========================================================================
function renderGanttTimeline(activeProps) {
  const container = document.getElementById('timeline-grid-container');
  container.innerHTML = '';
  
  if (activeProps.length === 0) {
    container.innerHTML = '<div class="todo-empty">当前无可见房源</div>';
    return;
  }
  
  const table = document.createElement('table');
  table.className = 'tg-table';
  
  // 1. 构建横向表头 THEAD (列为房源)
  const thead = document.createElement('thead');
  thead.className = 'tg-thead';
  const headerRow = document.createElement('tr');
  
  // 首列为“日期”
  const cornerHeader = document.createElement('th');
  cornerHeader.className = 'tg-col-date-header tg-col-corner';
  cornerHeader.innerText = '日期';
  headerRow.appendChild(cornerHeader);
  
  // 后续各列为房源名称
  activeProps.forEach(p => {
    const propHeader = document.createElement('th');
    propHeader.className = 'tg-col-prop';
    propHeader.innerText = p.name;
    headerRow.appendChild(propHeader);
  });
  
  thead.appendChild(headerRow);
  table.appendChild(thead);
  
  // 2. 构建数据表身 TBODY
  const tbody = document.createElement('tbody');
  
  // 外层循环：展示天数跨度 (e.g. 30天)
  for (let i = 0; i < state.timelineScale; i++) {
    const currentDate = addDays(state.timelineStartDate, i);
    const dateStr = formatDateString(currentDate);
    const dayOfWeek = currentDate.getDay();
    const todayStr = getTodayString();
    
    // 判断日期样式
    let dateClass = '';
    if (dateStr === todayStr) {
      dateClass = 'today-date';
    } else if (dayOfWeek === 6) {
      dateClass = 'weekend-sat';
    } else if (dayOfWeek === 0) {
      dateClass = 'weekend-sun';
    }
    
    const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    
    // 每日共包含 8 个纵向子行：第 1 行为房态行，第 2-8 行为备忘录行 (任务槽 1-7)
    for (let slot = 0; slot < 8; slot++) {
      const tr = document.createElement('tr');
      
      // 特殊底部描边：给第 8 行备注底线加粗，清晰隔离日期块
      if (slot === 7) {
        tr.className = 'tg-row-remark tg-row-last-remark';
      } else if (slot === 0) {
        tr.className = 'tg-row-booking';
      } else {
        tr.className = 'tg-row-remark';
      }
      
      // 第一子行的首个单元格为“日期列”，需要使用 rowspan="8" 跨越所有 8 个子行
      if (slot === 0) {
        const tdDate = document.createElement('td');
        tdDate.className = `tg-col-date-header ${dateClass}`;
        tdDate.rowSpan = 8;
        
        tdDate.innerHTML = `
          <span class="date-num">${currentDate.getDate()}</span>
          <span class="date-name">${dayNames[dayOfWeek]}</span>
          <span style="font-size: 0.65rem; opacity: 0.7; font-family: var(--font-sans); display:block; margin-top:2px;">
            ${(currentDate.getMonth() + 1)}/${currentDate.getDate()}
          </span>
        `;
        tr.appendChild(tdDate);
      }
      
      // 遍历渲染每个房源在该子行的单元格
      activeProps.forEach(p => {
        const td = document.createElement('td');
        
        if (slot === 0) {
          // A. 房态行 (自动同步)
          td.className = 'tg-cell-booking';
          const fStatus = getPropertyStatusForDate(p.id, dateStr);
          
          if (fStatus.status === 'split-out-in') {
            td.classList.add('status-split-out-in');
            td.title = `双客交接：\n上午退房\n下午入住`;
            td.onclick = (e) => {
              e.stopPropagation();
              showSplitBookingModal(p.name, fStatus.checkOutEvent, fStatus.checkInEvent);
            };
          } else if (fStatus.status === 'checkin') {
            td.classList.add('status-checkin');
            td.innerHTML = `<span class="cell-badge">入</span>`;
            td.onclick = () => showBookingModal(p.name, '新入住', fStatus.event);
          } else if (fStatus.status === 'checkout') {
            td.classList.add('status-checkout');
            td.innerHTML = `<span class="cell-badge">退</span>`;
            td.onclick = () => showBookingModal(p.name, '退房离店', fStatus.event);
          } else if (fStatus.status === 'reserved') {
            td.classList.add('status-reserved');
            td.onclick = () => showBookingModal(p.name, '已入住/占用', fStatus.event);
          } else {
            td.classList.add('status-vacant');
            td.onclick = () => showBookingModal(p.name, '空闲中', { start: dateStr, end: dateStr, summary: 'Available' });
          }
        } else {
          // B. 备忘录备注行 (槽 1-7对应 slot 1-7)
          td.className = 'tg-cell-remark';
          
          const remarkKey = `${dateStr}_${p.id}_${slot}`;
          const remarkText = state.remarksData[remarkKey] || '';
          
          if (remarkText) {
            td.innerHTML = parseRemarkTextHtml(remarkText);
          } else {
            td.classList.add('tg-cell-remark-empty');
            td.innerText = '-'; // 空白状态下显示轻量虚线
          }
          
          // 点击备注格子打开专属备忘录编辑弹窗
          td.onclick = () => openRemarksModal(p.id, p.name, dateStr, slot);
        }
        
        tr.appendChild(td);
      });
      
      tbody.appendChild(tr);
    }
  }
  
  table.appendChild(tbody);
  container.appendChild(table);
}

// 解析带有分类前缀的备注，将其包装为精美的日式彩色小标签
function parseRemarkTextHtml(text) {
  if (!text) return '';
  
  // 匹配前缀 (🔧 维修 | 🚒 消防 | 📦 配送 | 👥 人数 | 💬 需求)
  const match = text.match(/^(🔧 维修|🚒 消防|📦 配送|👥 人数|💬 需求)\s*(.*)$/);
  if (match) {
    const tag = match[1];
    const rest = match[2];
    
    let tagClass = 'tag-repair';
    if (tag.includes('消防')) tagClass = 'tag-fire';
    else if (tag.includes('配送')) tagClass = 'tag-delivery';
    else if (tag.includes('人数')) tagClass = 'tag-occupants';
    else if (tag.includes('需求')) tagClass = 'tag-request';
    
    return `<span class="remark-tag-pill ${tagClass}">${tag}</span>${escapeHtml(rest)}`;
  }
  
  return escapeHtml(text);
}

// ==========================================================================
// 9. 备忘录编辑弹窗控制核心 (Remarks Modal Controls)
// ==========================================================================
function openRemarksModal(propId, propName, dateStr, slotIdx) {
  state.remarksActivePropId = propId;
  state.remarksActiveDate = dateStr;
  state.remarksActiveSlotIdx = slotIdx;
  
  document.getElementById('remarks-modal-prop-name').innerText = propName;
  document.getElementById('remarks-modal-date').innerText = formatDateChinese(dateStr);
  document.getElementById('remarks-modal-slot-id').innerText = `第 ${slotIdx} 行备注槽`;
  
  // 读取已保存的数据
  const remarkKey = `${dateStr}_${propId}_${slotIdx}`;
  const existing = state.remarksData[remarkKey] || '';
  
  let tag = '';
  let textVal = existing;
  
  // 解析标签和文本
  const match = existing.match(/^(🔧 维修|🚒 消防|📦 配送|👥 人数|💬 需求)\s*(.*)$/);
  if (match) {
    tag = match[1];
    textVal = match[2];
  }
  
  state.remarksActiveTag = tag;
  document.getElementById('input-remark-text').value = textVal;
  
  // 高亮对应的标签按钮
  updateRemarksTagHighlight();
  
  document.getElementById('remarks-modal').classList.add('active');
  
  // 延迟聚焦输入框，优化键盘操作体验
  setTimeout(() => {
    document.getElementById('input-remark-text').focus();
  }, 100);
}

function updateRemarksTagHighlight() {
  const buttons = document.querySelectorAll('.type-buttons .btn-type-tag');
  buttons.forEach(btn => {
    const btnTag = btn.getAttribute('data-tag');
    if (btnTag === state.remarksActiveTag) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

function saveRemarks() {
  const textVal = document.getElementById('input-remark-text').value.trim();
  const key = `${state.remarksActiveDate}_${state.remarksActivePropId}_${state.remarksActiveSlotIdx}`;
  
  if (textVal === '') {
    // 文本为空则代表删除
    delete state.remarksData[key];
  } else {
    // 将标签前缀与文字拼装保存
    const fullText = state.remarksActiveTag ? `${state.remarksActiveTag} ${textVal}` : textVal;
    state.remarksData[key] = fullText;
  }
  
  // 写入 localStorage 本地库
  localStorage.setItem('airbnb_calendar_remarks', JSON.stringify(state.remarksData));
  
  hideRemarksModal();
  // 重新重绘整个瀑布流表格
  renderGanttTimeline(getPropertiesForActiveBrand());
}

function deleteRemark() {
  const key = `${state.remarksActiveDate}_${state.remarksActivePropId}_${state.remarksActiveSlotIdx}`;
  delete state.remarksData[key];
  
  localStorage.setItem('airbnb_calendar_remarks', JSON.stringify(state.remarksData));
  hideRemarksModal();
  renderGanttTimeline(getPropertiesForActiveBrand());
}

function hideRemarksModal() {
  document.getElementById('remarks-modal').classList.remove('active');
}

// ==========================================================================
// 10. 单房源月度精细日历渲染 (Monthly Grid Calendar)
// ==========================================================================
function populatePropertyDropdown(activeProps) {
  const dropdown = document.getElementById('select-property');
  dropdown.innerHTML = '';
  
  if (activeProps.length === 0) return;
  
  activeProps.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.innerText = p.name;
    dropdown.appendChild(opt);
  });
  
  state.selectedPropertyId = activeProps[0].id;
  updateSingleCalendarInfo();
}

function updateSingleCalendarInfo() {
  const propId = state.selectedPropertyId;
  const prop = getPropertyById(propId);
  if (!prop) return;
  
  document.getElementById('sidebar-prop-name').innerText = prop.name;
  document.getElementById('sidebar-brand-name').innerText = getBrandNameForProperty(prop.name);
  
  renderMonthlyGrid();
  renderSidebarBookingList(propId);
}

function getPropertyById(propId) {
  for (const b of state.rawConfig) {
    const found = b.properties.find(p => p.id === propId);
    if (found) return found;
  }
  return null;
}

function renderMonthlyGrid() {
  const body = document.getElementById('calendar-body');
  body.innerHTML = '';
  
  const yr = state.calendarYear;
  const mo = state.calendarMonth;
  
  document.getElementById('calendar-month-year').innerText = `${yr}年 ${mo + 1}月`;
  
  const firstDayIndex = new Date(yr, mo, 1).getDay();
  const totalDays = getDaysInMonth(yr, mo);
  const prevMonthTotalDays = getDaysInMonth(mo === 0 ? yr - 1 : yr, mo === 0 ? 11 : mo - 1);
  
  const todayStr = getTodayString();
  const propId = state.selectedPropertyId;
  
  let dayCounter = 1;
  let nextMonthDayCounter = 1;
  
  for (let r = 0; r < 6; r++) {
    const tr = document.createElement('tr');
    let allNextMonth = true;
    
    for (let c = 0; c < 7; c++) {
      const td = document.createElement('td');
      const cellIdx = r * 7 + c;
      
      if (cellIdx < firstDayIndex) {
        td.className = 'other-month';
        const dateNum = prevMonthTotalDays - firstDayIndex + cellIdx + 1;
        td.innerHTML = `<span class="cal-date-num">${dateNum}</span>`;
        allNextMonth = false;
      } else if (dayCounter > totalDays) {
        td.className = 'other-month';
        td.innerHTML = `<span class="cal-date-num">${nextMonthDayCounter++}</span>`;
      } else {
        allNextMonth = false;
        const curDay = dayCounter++;
        const dateStr = `${yr}-${String(mo + 1).padStart(2, '0')}-${String(curDay).padStart(2, '0')}`;
        
        if (c === 6) td.classList.add('sat');
        if (c === 0) td.classList.add('sun');
        if (dateStr === todayStr) td.classList.add('today-cell');
        
        const fStatus = getPropertyStatusForDate(propId, dateStr);
        let statusStripeHtml = '';
        
        if (fStatus.status === 'split-out-in') {
          td.style.background = 'linear-gradient(135deg, var(--color-aizome-bg) 50%, var(--color-kaki-bg) 50%)';
          statusStripeHtml = `<div class="cal-booking-stripe" style="color: var(--accent-gold); font-size: 0.65rem;">🌓 换客交接</div>`;
          td.onclick = () => showSplitBookingModal(getPropertyById(propId).name, fStatus.checkOutEvent, fStatus.checkInEvent);
        } else if (fStatus.status === 'checkin') {
          td.style.backgroundColor = 'var(--color-kaki-bg)';
          statusStripeHtml = `<div class="cal-booking-stripe" style="color: var(--color-kaki)">🍂 今日入住</div>`;
          td.onclick = () => showBookingModal(getPropertyById(propId).name, '新入住', fStatus.event);
        } else if (fStatus.status === 'checkout') {
          td.style.backgroundColor = 'var(--color-aizome-bg)';
          statusStripeHtml = `<div class="cal-booking-stripe" style="color: var(--color-aizome)">🌾 今日退房</div>`;
          td.onclick = () => showBookingModal(getPropertyById(propId).name, '退房离店', fStatus.event);
        } else if (fStatus.status === 'reserved') {
          td.style.backgroundColor = 'var(--color-sakura-bg)';
          statusStripeHtml = `<div class="cal-booking-stripe" style="color: var(--color-sakura)">🌸 已占用</div>`;
          td.onclick = () => showBookingModal(getPropertyById(propId).name, '已入住/占用', fStatus.event);
        } else {
          td.style.backgroundColor = 'var(--color-uguisu-bg)';
          td.onclick = () => showBookingModal(getPropertyById(propId).name, '空闲中', { start: dateStr, end: dateStr, summary: 'Available' });
        }
        
        td.innerHTML = `
          <div class="cal-cell-inner">
            <span class="cal-date-num">${curDay}</span>
            ${statusStripeHtml}
          </div>
        `;
      }
      tr.appendChild(td);
    }
    
    if (allNextMonth && r >= 5) break;
    body.appendChild(tr);
  }
}

function renderSidebarBookingList(propId) {
  const container = document.getElementById('sidebar-bookings');
  container.innerHTML = '';
  
  const prop = state.propertiesData[propId];
  if (!prop || !prop.events || prop.events.length === 0) {
    container.innerHTML = '<div class="todo-empty">近期无预订日程</div>';
    document.getElementById('stat-booked-days').innerText = '0 天';
    document.getElementById('stat-occupancy-rate').innerText = '0%';
    return;
  }
  
  const sortedEvents = [...prop.events].sort((a,b) => new Date(a.start) - new Date(b.start));
  let bookedNightsInMonth = 0;
  const currentMonthStart = new Date(state.calendarYear, state.calendarMonth, 1);
  const currentMonthEnd = new Date(state.calendarYear, state.calendarMonth + 1, 1);
  
  sortedEvents.forEach(ev => {
    const card = document.createElement('div');
    card.className = 'sidebar-booking-item';
    const nights = getNights(ev.start, ev.end);
    
    card.innerHTML = `
      <div>
        <strong style="color: var(--border-wood-dark)">${formatDateChinese(ev.start)}</strong>
        <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;">退房: ${formatDateChinese(ev.end)}</div>
      </div>
      <span class="todo-nights" style="background-color: var(--accent-gold-light); color: var(--accent-gold); border-color: var(--accent-gold);">${nights}晚</span>
    `;
    
    card.onclick = () => showBookingModal(prop.propName, '日程详情', ev);
    container.appendChild(card);
    
    const evStart = new Date(ev.start);
    const evEnd = new Date(ev.end);
    
    const overlapStart = evStart < currentMonthStart ? currentMonthStart : evStart;
    const overlapEnd = evEnd > currentMonthEnd ? currentMonthEnd : evEnd;
    
    if (overlapStart < overlapEnd) {
      const diffTime = Math.abs(overlapEnd - overlapStart);
      bookedNightsInMonth += Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    }
  });
  
  const daysInMonth = getDaysInMonth(state.calendarYear, state.calendarMonth);
  document.getElementById('stat-booked-days').innerText = `${bookedNightsInMonth} 天`;
  const mRate = Math.round((bookedNightsInMonth / daysInMonth) * 100);
  document.getElementById('stat-occupancy-rate').innerText = `${mRate}%`;
}

// ==========================================================================
// 11. 预订详情与双客交错弹窗控制
// ==========================================================================
function showBookingModal(propertyName, statusText, event) {
  const modal = document.getElementById('booking-modal');
  document.getElementById('modal-prop-name').innerText = propertyName;
  
  const statusEl = document.getElementById('modal-status');
  statusEl.innerText = statusText;
  statusEl.className = 'field-value';
  
  if (statusText.includes('入住')) {
    statusEl.style.color = 'var(--color-kaki)';
  } else if (statusText.includes('退房')) {
    statusEl.style.color = 'var(--color-aizome)';
  } else if (statusText.includes('已') || statusText.includes('占用')) {
    statusEl.style.color = 'var(--color-sakura)';
  } else {
    statusEl.style.color = 'var(--color-uguisu)';
  }
  
  document.getElementById('modal-start-date').innerText = formatDateChinese(event.start);
  document.getElementById('modal-end-date').innerText = formatDateChinese(event.end);
  
  const nights = getNights(event.start, event.end);
  document.getElementById('modal-nights').innerText = `${nights} 晚`;
  
  const phoneRow = document.getElementById('modal-field-phone');
  const linkRow = document.getElementById('modal-field-link');
  
  if (event.phoneLast4) {
    phoneRow.style.display = 'flex';
    document.getElementById('modal-phone').innerText = `*** - **** - ${event.phoneLast4}`;
  } else {
    phoneRow.style.display = 'none';
  }
  
  if (event.reservationUrl) {
    linkRow.style.display = 'flex';
    document.getElementById('modal-link').href = event.reservationUrl;
  } else {
    linkRow.style.display = 'none';
  }
  modal.classList.add('active');
}

function showSplitBookingModal(propertyName, checkOutEvent, checkInEvent) {
  const confirmStr = `房源 [${propertyName}] 今日正在进行【换客交接】！\n\n` +
                     `🧹 上午退房客人订单：\n日期: ${checkOutEvent.start} 至 ${checkOutEvent.end} (${getNights(checkOutEvent.start, checkOutEvent.end)}晚)\n` +
                     (checkOutEvent.phoneLast4 ? `电话后4位: ${checkOutEvent.phoneLast4}\n` : '') +
                     `\n🍁 下午入住客人订单：\n日期: ${checkInEvent.start} 至 ${checkInEvent.end} (${getNights(checkInEvent.start, checkInEvent.end)}晚)\n` +
                     (checkInEvent.phoneLast4 ? `电话后4位: ${checkInEvent.phoneLast4}\n` : '') +
                     `\n需要查看哪个订单的详细操作？`;
                     
  const opt = confirm(confirmStr + '\n\n【确定】：查看【下午入住】订单；【取消】：查看【上午退房】订单。');
  if (opt) {
    showBookingModal(propertyName, '今日新入住 (换客中)', checkInEvent);
  } else {
    showBookingModal(propertyName, '今日待退房 (换客中)', checkOutEvent);
  }
}

function hideBookingModal() {
  document.getElementById('booking-modal').classList.remove('active');
}

// ==========================================================================
// 12. 控制监听与程序初始化 (Event Handlers & Bootstrapper)
// ==========================================================================
function setupEventListeners() {
  // 1. 甘特图时间轴跨度切换 (15, 30, 60天)
  document.getElementById('btn-scale-15').onclick = (e) => setTimelineScale(15, e.target);
  document.getElementById('btn-scale-30').onclick = (e) => setTimelineScale(30, e.target);
  document.getElementById('btn-scale-60').onclick = (e) => setTimelineScale(60, e.target);
  
  // 2. 甘特图纵向时间向前、向后移天数（根据当前尺度大小平滑移动）
  document.getElementById('btn-time-prev').onclick = () => {
    state.timelineStartDate = addDays(state.timelineStartDate, -state.timelineScale);
    renderGanttTimeline(getPropertiesForActiveBrand());
  };
  document.getElementById('btn-time-today').onclick = () => {
    state.timelineStartDate = new Date();
    renderGanttTimeline(getPropertiesForActiveBrand());
  };
  document.getElementById('btn-time-next').onclick = () => {
    state.timelineStartDate = addDays(state.timelineStartDate, state.timelineScale);
    renderGanttTimeline(getPropertiesForActiveBrand());
  };
  
  // 3. 手动刷新按钮触发跨域拉取
  document.getElementById('btn-manual-sync').onclick = async () => {
    await fetchLiveSyncFallback();
  };
  
  // 4. 单日历房源选择改变联动
  document.getElementById('select-property').onchange = (e) => {
    state.selectedPropertyId = e.target.value;
    updateSingleCalendarInfo();
  };
  
  // 5. 单日历跨月导航
  document.getElementById('btn-cal-prev').onclick = () => {
    if (state.calendarMonth === 0) {
      state.calendarMonth = 11;
      state.calendarYear -= 1;
    } else {
      state.calendarMonth -= 1;
    }
    updateSingleCalendarInfo();
  };
  
  document.getElementById('btn-cal-next').onclick = () => {
    if (state.calendarMonth === 11) {
      state.calendarMonth = 0;
      state.calendarYear += 1;
    } else {
      state.calendarMonth += 1;
    }
    updateSingleCalendarInfo();
  };
  
  // 6. 预订详情弹窗关闭
  document.getElementById('btn-close-modal').onclick = hideBookingModal;
  document.getElementById('btn-close-modal-confirm').onclick = hideBookingModal;
  document.getElementById('booking-modal').onclick = (e) => {
    if (e.target.id === 'booking-modal') hideBookingModal();
  };
  
  // 7. 备忘录编辑弹窗交互绑定
  document.getElementById('btn-close-remarks-modal').onclick = hideRemarksModal;
  document.getElementById('btn-cancel-remarks').onclick = hideRemarksModal;
  document.getElementById('btn-save-remarks').onclick = saveRemarks;
  document.getElementById('btn-delete-remark').onclick = deleteRemark;
  
  // 分类标签按钮的选取切换
  const tagButtons = document.querySelectorAll('.type-buttons .btn-type-tag');
  tagButtons.forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      state.remarksActiveTag = btn.getAttribute('data-tag');
      updateRemarksTagHighlight();
    };
  });
  
  // 备忘录弹窗背景板点击关闭
  document.getElementById('remarks-modal').onclick = (e) => {
    if (e.target.id === 'remarks-modal') hideRemarksModal();
  };
}

function setTimelineScale(days, buttonEl) {
  state.timelineScale = days;
  
  document.querySelectorAll('.timeline-controls .btn-toggle').forEach(btn => {
    btn.classList.remove('active');
  });
  buttonEl.classList.add('active');
  
  renderGanttTimeline(getPropertiesForActiveBrand());
}

// 主启动引导程序
function init() {
  console.log('🌸 正在初始化日系纵向房态与排班备忘大盘...');
  
  const today = new Date();
  state.timelineStartDate = today;
  state.calendarYear = today.getFullYear();
  state.calendarMonth = today.getMonth();
  
  setupEventListeners();
  loadData();
}

// 启动大盘！
window.onload = init;

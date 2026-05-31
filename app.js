/**
 * 雲町屋 & 多品牌房源日历看板 - 核心交互与渲染逻辑 (app.js)
 * 
 * 核心功能：
 * 1. 初始化 Tab 并提供多品牌筛选联动
 * 2. 双轨数据加载：读取 data.json -> 缓存 -> 客户端 CORS 代理实时获取
 * 3. 房态决策系统：计算任意日期下房源是 空闲/预订/入住/退房/半格交接 状态
 * 4. 动态绘制 7天/15天/30天 多房源甘特图时间轴
 * 5. 动态绘制单房源月历卡片与统计分析
 * 6. 提供预订详情模态弹窗 (Modal)
 */

// ==========================================================================
// 1. 全局状态管理 (Application State)
// ==========================================================================
const state = {
  currentBrandId: 'yunmachiya', // 当前选中的品牌，'all' 代表所有品牌
  timelineStartDate: null,      // 甘特图起始日期 (Date 对象)
  timelineScale: 7,             // 甘特图展示天数 (7, 15, 30)
  selectedPropertyId: '',       // 单日历当前选中房源
  calendarYear: null,           // 单日历当前年份
  calendarMonth: null,          // 单日历当前月份 (0-11)
  
  // 核心房态数据源
  lastUpdated: null,
  propertiesData: {},           // 键为 propId，值为 { propId, propName, brandId, events: [...] }
  rawConfig: BRANDS_CONFIG      // 来自 config.js
};

// CORS 代理服务列表，备用切换提高可用性
const CORS_PROXIES = [
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
];

// ==========================================================================
// 2. 日期工具函数 (Date Utility Functions)
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
// 5. 数据源拉取与缓存 (Data Loaders & API Client)
// ==========================================================================
async function loadData() {
  showSyncButtonLoading(true);
  
  // A. 尝试从 localStorage 优先读取本地缓存，加快二次访问速度
  const cachedData = localStorage.getItem('airbnb_calendar_data');
  if (cachedData) {
    try {
      const parsed = JSON.parse(cachedData);
      // 仅当缓存不超过20分钟时使用
      const cacheTime = new Date(parsed.lastUpdated);
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

  // B. 读取由 GitHub Actions 生成的最新静态 data.json
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
  
  // 更新顶部同步时间指示器
  const timeString = new Date(state.lastUpdated).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  document.getElementById('sync-time-string').innerText = timeString;
  
  // 数据装载后，开始全盘渲染
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
// 6. UI 渲染引擎 (Render Engines)
// ==========================================================================

// A. 渲染品牌导航 Tabs
function renderBrandTabs() {
  const container = document.getElementById('brand-tabs');
  container.innerHTML = '';
  
  // 1. 各别品牌 Tab
  state.rawConfig.forEach(brand => {
    const button = document.createElement('button');
    button.className = `brand-tab ${state.currentBrandId === brand.id ? 'active' : ''}`;
    button.innerHTML = `${brand.icon} ${brand.name}`;
    button.onclick = () => switchBrand(brand.id);
    container.appendChild(button);
  });
  
  // 2. "所有品牌" 聚合 Tab
  const allButton = document.createElement('button');
  allButton.className = `brand-tab ${state.currentBrandId === 'all' ? 'active' : ''}`;
  allButton.innerHTML = `🌐 混合总览`;
  allButton.onclick = () => switchBrand('all');
  container.appendChild(allButton);
}

// 切换选中的品牌 Tab 标签
function switchBrand(brandId) {
  state.currentBrandId = brandId;
  
  // 更新 Tab 高亮
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
  
  // 获取该品牌下的全部房源
  const activeProps = getPropertiesForActiveBrand();
  
  // 1. 刷新大盘统计数据 (KPIs)
  renderKPISummary(activeProps);
  
  // 2. 刷新今日待办事项列表 (新入住与退房)
  renderDailyTodoList(activeProps);
  
  // 3. 刷新多房源甘特图 (Gantt Chart)
  renderGanttTimeline(activeProps);
  
  // 4. 刷新单日历房源下拉菜单
  populatePropertyDropdown(activeProps);
}

// 获取当前激活品牌下的房源数组
function getPropertiesForActiveBrand() {
  if (state.currentBrandId === 'all') {
    // 合并全部品牌的全部房源
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

// B. 渲染统计数据 KPI 面板
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
      occupiedCount++; // 今日这晚这间房是被订了的
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
  
  // 计算入住率
  const rate = total > 0 ? Math.round((occupiedCount / total) * 100) : 0;
  document.getElementById('kpi-occupancy-rate').innerText = `${rate}%`;
}

// C. 渲染今日待办项详细列表
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
    
    // 如果是今日入住
    if (s === 'checkin' || s === 'split-out-in') {
      hasIn = true;
      const ev = s === 'checkin' ? fStatus.event : fStatus.checkInEvent;
      const card = createTodoCard(p.name, ev, 'checkin');
      listCheckin.appendChild(card);
    }
    
    // 如果是今日退房
    if (s === 'checkout' || s === 'split-out-in') {
      hasOut = true;
      const ev = s === 'checkout' ? fStatus.event : fStatus.checkOutEvent;
      const card = createTodoCard(p.name, ev, 'checkout');
      listCheckout.appendChild(card);
    }
  });
  
  if (!hasIn) {
    listCheckin.innerHTML = '<div class="todo-empty">🏮 今日无新入住客房</div>';
  }
  if (!hasOut) {
    listCheckout.innerHTML = '<div class="todo-empty">🧹 今日无退房保洁日程</div>';
  }
}

function createTodoCard(propertyName, event, type) {
  const item = document.createElement('div');
  item.className = 'todo-item';
  
  const nights = getNights(event.start, event.end);
  const brandName = getBrandNameForProperty(propertyName);
  
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

// D. 渲染多房源甘特图纵览 (Gantt Timeline Chart)
function renderGanttTimeline(activeProps) {
  const container = document.getElementById('timeline-grid-container');
  container.innerHTML = '';
  
  if (activeProps.length === 0) {
    container.innerHTML = '<div class="todo-empty">当前无可见房源</div>';
    return;
  }
  
  const table = document.createElement('table');
  table.className = 'tg-table';
  
  // 1. 构建表头 THEAD
  const thead = document.createElement('thead');
  thead.className = 'tg-thead';
  const headerRow = document.createElement('tr');
  
  // 第一列为“房源名称”
  const nameHeader = document.createElement('th');
  nameHeader.className = 'tg-col-prop-header';
  nameHeader.innerText = '房源名称';
  headerRow.appendChild(nameHeader);
  
  // 计算日期序列天数
  const dateList = [];
  for (let i = 0; i < state.timelineScale; i++) {
    const nextDate = addDays(state.timelineStartDate, i);
    dateList.push(nextDate);
    
    const dayHeader = document.createElement('th');
    dayHeader.className = 'tg-day-header';
    
    // 高亮周末与今天
    const dayOfWeek = nextDate.getDay();
    const dateStr = formatDateString(nextDate);
    const todayStr = getTodayString();
    
    if (dateStr === todayStr) {
      dayHeader.classList.add('today');
    } else if (dayOfWeek === 6) {
      dayHeader.classList.add('weekend-sat');
    } else if (dayOfWeek === 0) {
      dayHeader.classList.add('weekend-sun');
    }
    
    const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    
    dayHeader.innerHTML = `
      <span class="day-number">${nextDate.getDate()}</span>
      <span class="day-name">${dayNames[dayOfWeek]}</span>
    `;
    
    headerRow.appendChild(dayHeader);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);
  
  // 2. 构建数据表身 TBODY
  const tbody = document.createElement('tbody');
  
  activeProps.forEach(p => {
    const row = document.createElement('tr');
    row.className = 'tg-row';
    
    // 首列：房源标题
    const cellProp = document.createElement('td');
    cellProp.className = 'tg-col-prop-header';
    cellProp.innerHTML = `<span>${p.name}</span>`;
    row.appendChild(cellProp);
    
    // 渲染日期单元格
    dateList.forEach(date => {
      const dateStr = formatDateString(date);
      const cell = document.createElement('td');
      cell.className = 'tg-cell';
      
      const fStatus = getPropertyStatusForDate(p.id, dateStr);
      
      // 应用对应的和风状态色
      if (fStatus.status === 'split-out-in') {
        cell.classList.add('status-split-out-in');
        cell.title = `上午退房: ${fStatus.checkOutEvent.uid.substring(0,6)}...\n下午入住: ${fStatus.checkInEvent.uid.substring(0,6)}...`;
        
        // 绑定点击详情
        cell.onclick = (e) => {
          e.stopPropagation();
          // 如果双击或点击偏右，展示入住，偏左展示退房。简化为弹窗选择或展示综合详情。
          showSplitBookingModal(p.name, fStatus.checkOutEvent, fStatus.checkInEvent);
        };
      } else if (fStatus.status === 'checkin') {
        cell.classList.add('status-checkin');
        cell.innerHTML = `<span class="cell-badge">入</span>`;
        cell.onclick = () => showBookingModal(p.name, '新入住', fStatus.event);
      } else if (fStatus.status === 'checkout') {
        cell.classList.add('status-checkout');
        cell.innerHTML = `<span class="cell-badge">退</span>`;
        cell.onclick = () => showBookingModal(p.name, '退房离店', fStatus.event);
      } else if (fStatus.status === 'reserved') {
        cell.classList.add('status-reserved');
        cell.onclick = () => showBookingModal(p.name, '已入住/占用', fStatus.event);
      } else {
        cell.classList.add('status-vacant');
        // 点击空置格，可以提醒用户此房在此日可用
        cell.onclick = () => {
          showBookingModal(p.name, '空闲中', { start: dateStr, end: dateStr, summary: 'Available' });
        };
      }
      
      row.appendChild(cell);
    });
    tbody.appendChild(row);
  });
  
  table.appendChild(tbody);
  container.appendChild(table);
}

// E. 渲染单房源日历网格
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
  
  // 默认选中第一个房源，并重绘日历
  state.selectedPropertyId = activeProps[0].id;
  updateSingleCalendarInfo();
}

function updateSingleCalendarInfo() {
  const propId = state.selectedPropertyId;
  const prop = getPropertyById(propId);
  if (!prop) return;
  
  document.getElementById('sidebar-prop-name').innerText = prop.name;
  document.getElementById('sidebar-brand-name').innerText = getBrandNameForProperty(prop.name);
  
  // 重新计算并画月历网格
  renderMonthlyGrid();
  // 填充侧边预订列表
  renderSidebarBookingList(propId);
}

function getPropertyById(propId) {
  for (const b of state.rawConfig) {
    const found = b.properties.find(p => p.id === propId);
    if (found) return found;
  }
  return null;
}

// 画月历网格的核心算法 (35 或 42 格布局)
function renderMonthlyGrid() {
  const body = document.getElementById('calendar-body');
  body.innerHTML = '';
  
  const yr = state.calendarYear;
  const mo = state.calendarMonth;
  
  // 设置月份中文字幕
  document.getElementById('calendar-month-year').innerText = `${yr}年 ${mo + 1}月`;
  
  // 该月第一天是周几
  const firstDayIndex = new Date(yr, mo, 1).getDay();
  // 该月总天数
  const totalDays = getDaysInMonth(yr, mo);
  // 上一个月总天数
  const prevMonthTotalDays = getDaysInMonth(mo === 0 ? yr - 1 : yr, mo === 0 ? 11 : mo - 1);
  
  const todayStr = getTodayString();
  const propId = state.selectedPropertyId;
  
  let dayCounter = 1;
  let nextMonthDayCounter = 1;
  
  // 建立一个 6 行 7 列的日历矩阵
  for (let r = 0; r < 6; r++) {
    const tr = document.createElement('tr');
    
    // 是否此行全是下一个月的天数，若是且已画满 35 天则停止绘制
    let allNextMonth = true;
    
    for (let c = 0; c < 7; c++) {
      const td = document.createElement('td');
      const cellIdx = r * 7 + c;
      
      if (cellIdx < firstDayIndex) {
        // A. 上个月的补全格子
        td.className = 'other-month';
        const dateNum = prevMonthTotalDays - firstDayIndex + cellIdx + 1;
        td.innerHTML = `<span class="cal-date-num">${dateNum}</span>`;
        allNextMonth = false;
      } else if (dayCounter > totalDays) {
        // B. 下个月的补全格子
        td.className = 'other-month';
        td.innerHTML = `<span class="cal-date-num">${nextMonthDayCounter++}</span>`;
      } else {
        // C. 当月核心天数
        allNextMonth = false;
        const curDay = dayCounter++;
        const dateStr = `${yr}-${String(mo + 1).padStart(2, '0')}-${String(curDay).padStart(2, '0')}`;
        
        // 区分周末样式
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
          // 空置状态
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
    
    // 如果全行都是下个月的格子，而且我们至少画完了5行（35格），就没必要画第6行了
    if (allNextMonth && r >= 5) {
      break;
    }
    body.appendChild(tr);
  }
}

// 侧边栏：渲染该房源的所有未来预订卡片
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
  
  // 按起始日期升序排列
  const sortedEvents = [...prop.events].sort((a,b) => new Date(a.start) - new Date(b.start));
  
  // 筛选出在该月内的已订天数
  let bookedNightsInMonth = 0;
  const currentMonthStart = new Date(state.calendarYear, state.calendarMonth, 1);
  const currentMonthEnd = new Date(state.calendarYear, state.calendarMonth + 1, 1);
  
  sortedEvents.forEach(ev => {
    // 渲染最近未来的预订日程卡片
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
    
    // 计算月度入住统计
    const evStart = new Date(ev.start);
    const evEnd = new Date(ev.end);
    
    // 重合计算：取交集
    const overlapStart = evStart < currentMonthStart ? currentMonthStart : evStart;
    const overlapEnd = evEnd > currentMonthEnd ? currentMonthEnd : evEnd;
    
    if (overlapStart < overlapEnd) {
      const diffTime = Math.abs(overlapEnd - overlapStart);
      bookedNightsInMonth += Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    }
  });
  
  // 侧边栏小看板统计更新
  const daysInMonth = getDaysInMonth(state.calendarYear, state.calendarMonth);
  document.getElementById('stat-booked-days').innerText = `${bookedNightsInMonth} 天`;
  
  const mRate = Math.round((bookedNightsInMonth / daysInMonth) * 100);
  document.getElementById('stat-occupancy-rate').innerText = `${mRate}%`;
}

// ==========================================================================
// 7. 弹窗交互控制 (Booking Detail Modals)
// ==========================================================================
function showBookingModal(propertyName, statusText, event) {
  const modal = document.getElementById('booking-modal');
  
  document.getElementById('modal-prop-name').innerText = propertyName;
  
  const statusEl = document.getElementById('modal-status');
  statusEl.innerText = statusText;
  
  // 匹配样式类
  statusEl.className = 'field-value';
  if (statusText.includes('入住') || statusText.includes('Check-in')) {
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
  
  // 电话后四位与外链 (仅 Reserved 态且 iCal 存在时有用)
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

// 处理“一天内既有退房又有入住”的极端换客交接弹窗
function showSplitBookingModal(propertyName, checkOutEvent, checkInEvent) {
  // 这里做一个友好体验：直接告诉用户这天上午需要做保洁迎接新房客，同时给他们两个按钮去查看两个订单的具体详情
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
// 8. 控制监听与程序初始化 (Event Handlers & Bootstrapper)
// ==========================================================================
function setupEventListeners() {
  // 1. 甘特图时间尺切换 (7, 15, 30天)
  document.getElementById('btn-scale-7').onclick = (e) => setTimelineScale(7, e.target);
  document.getElementById('btn-scale-15').onclick = (e) => setTimelineScale(15, e.target);
  document.getElementById('btn-scale-30').onclick = (e) => setTimelineScale(30, e.target);
  
  // 2. 甘特图时间导航 (向前、向后、今天)
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
  
  // 6. 弹窗关闭监听
  document.getElementById('btn-close-modal').onclick = hideBookingModal;
  document.getElementById('btn-close-modal-confirm').onclick = hideBookingModal;
  document.getElementById('booking-modal').onclick = (e) => {
    if (e.target.id === 'booking-modal') hideBookingModal();
  };
}

function setTimelineScale(days, buttonEl) {
  state.timelineScale = days;
  
  // 管理按钮高亮
  document.querySelectorAll('.timeline-controls .btn-toggle').forEach(btn => {
    btn.classList.remove('active');
  });
  buttonEl.classList.add('active');
  
  // 重新绘制
  renderGanttTimeline(getPropertiesForActiveBrand());
}

// 主启动引导程序
function init() {
  console.log('🌸 正在初始化日系房态日历大盘...');
  
  const today = new Date();
  state.timelineStartDate = today;
  state.calendarYear = today.getFullYear();
  state.calendarMonth = today.getMonth();
  
  setupEventListeners();
  loadData();
}

// 启动大盘！
window.onload = init;

/**
 * 雲町屋 & 多品牌房源日历看板 - 核心交互与重构渲染逻辑 (app.js)
 * 
 * 核心功能：
 * 1. 初始化 Tab 并提供多品牌筛选联动
 * 2. ⚙️ [新增] 加载优先级：优先读取 localStorage 自定义配置 `airbnb_calendar_custom_config`
 * 3. 双轨数据加载：读取 data.json -> 缓存 -> 客户端 CORS 代理实时获取
 * 4. 房态决策系统：计算任意日期下房源是 空闲/预订/入住/退房/半格交接 状态
 * 5. 🔄 纵向瀑布流甘特图 (Y-轴为日期，X-轴为房源列)
 * 6. 📋 [重构] 每日 8 行子格精细着色决策引擎 (按住退房/入住时间轴无缝填充)
 * 7. ✂️ [新增] 房源列头品牌前缀智能去重
 * 8. ⚙️ [新增] 房源与品牌图形化管理器 (Brands & Listings Manager)
 * 9. 💾 备忘录持久化读写与分类标签渲染
 * 10. 动态绘制单房源月历卡片与统计分析，提供详情模态弹窗
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
  rawConfig: [],                // 当前运行的品牌房源配置列表 (从 config.js 或 localStorage 装载)
  
  // 备忘录/任务数据 (持久化于 localStorage)
  remarksData: {},              // 键为 "YYYY-MM-DD_propId_slotIdx" (slotIdx 1-7对应子行2-8)
  
  // 自定义预订订单详情备忘 (创建日期, 入住人数，持久化于 localStorage)
  customBookingDetails: {},     // 键为 event 唯一的 uid, 值为 { createdDate, guests }
  activeModalEventUid: '',      // 当前详情弹窗展示的预订 UID
  
  // 处于活动编辑中的备注信息
  remarksActivePropId: '',
  remarksActiveDate: '',
  remarksActiveSlotIdx: 0,
  remarksActiveTag: '',
  
  // 房源管理器临时工作状态
  tempConfigProps: [],          // 弹窗中扁平化的房源编辑草稿列表
  managerMode: 'table',         // 编辑器模式：'table' 或 'text'
  isFirstLoad: true,            // 是否是第一次加载页面以执行滚动定位
  isRenderingTimeline: false    // 防止滚动触发重绘冲突的锁
};

// CORS 代理服务列表，优先采用自建的 Vercel 后端安全代理，确保 100% 同步成功
const CORS_PROXIES = [
  url => `/api/proxy?url=${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
];

// ==========================================================================
// 2. 日期与文本工具函数 (Utility Functions)
// ==========================================================================
function getTodayString() {
  const d = new Date();
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  try {
    const parts = formatter.formatToParts(d);
    const year = parts.find(p => p.type === 'year').value;
    const month = parts.find(p => p.type === 'month').value;
    const day = parts.find(p => p.type === 'day').value;
    return `${year}-${month}-${day}`;
  } catch (e) {
    const formatted = formatter.format(d);
    return formatted.replace(/\//g, '-');
  }
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

function getNights(startStr, endStr) {
  const start = new Date(startStr);
  const end = new Date(endStr);
  const diffTime = Math.abs(end - start);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function formatDateChinese(dateStr) {
  if (!dateStr) return '-';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  return `${parts[0]}年${parseInt(parts[1])}月${parseInt(parts[2])}日`;
}

function formatDateDot(dateStr) {
  if (!dateStr) return '-';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

function isReservationEvent(ev) {
  if (!ev) return false;
  
  // 1. 如果有明确的预订链接，肯定是预订
  const desc = (ev.description || '').trim();
  if (ev.reservationUrl || desc.includes('Reservation URL') || desc.includes('预订链接') || desc.includes('预订URL')) {
    return true;
  }
  
  // 2. 分析事件标题 (Summary)
  const summary = (ev.summary || '').trim();
  if (!summary) {
    return false; // 空标题默认视为锁房
  }
  
  const summaryLower = summary.toLowerCase();
  
  // 检查是否包含锁房/不可用关键字
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

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

let toastTimeout = null;
function showToast(msg, type = 'info') {
  const banner = document.getElementById('toast-banner');
  const messageEl = document.getElementById('toast-message');
  const iconEl = document.getElementById('toast-icon');
  
  if (!banner || !messageEl || !iconEl) return;
  
  let icon = '🏮';
  if (type === 'success') icon = '🌸';
  else if (type === 'warning') icon = '⚠️';
  else if (type === 'error') icon = '❌';
  
  iconEl.innerText = icon;
  messageEl.innerText = msg;
  
  banner.classList.add('active');
  
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    banner.classList.remove('active');
  }, 4000);
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
          
          const urlMatch = value.match(/Reservation URL: (https:\/\/[^\s\\]+)/i);
          if (urlMatch) currentEvent.reservationUrl = urlMatch[1].trim();
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
function getPropertyStatusForDate(propId, dateStr) {
  const prop = state.propertiesData[propId];
  if (!prop || !prop.events) return { status: 'vacant' };
  
  let isCheckIn = false;
  let isCheckOut = false;
  let isBetween = false;
  
  let checkInEvent = null;
  let checkOutEvent = null;
  let activeEvent = null;
  
  // Also track blocked dates
  let isBlockedCheckIn = false;
  let isBlockedCheckOut = false;
  let isBlockedBetween = false;
  let blockedCheckInEvent = null;
  let blockedCheckOutEvent = null;
  let blockedActiveEvent = null;
  
  for (const ev of prop.events) {
    const isReal = isReservationEvent(ev);
    
    if (isReal) {
      if (ev.start === dateStr) {
        isCheckIn = true;
        checkInEvent = ev;
      }
      if (ev.end === dateStr) {
        isCheckOut = true;
        checkOutEvent = ev;
      }
      if (dateStr >= ev.start && dateStr < ev.end) {
        isBetween = true;
        activeEvent = ev;
      }
    } else {
      if (ev.start === dateStr) {
        isBlockedCheckIn = true;
        blockedCheckInEvent = ev;
      }
      if (ev.end === dateStr) {
        isBlockedCheckOut = true;
        blockedCheckOutEvent = ev;
      }
      if (dateStr >= ev.start && dateStr < ev.end) {
        isBlockedBetween = true;
        blockedActiveEvent = ev;
      }
    }
  }
  
  // Real guest bookings take absolute precedence
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
  
  // If no guest booking exists, return block statuses
  if (isBlockedCheckIn && isBlockedCheckOut) {
    return { status: 'blocked-split', checkOutEvent: blockedCheckOutEvent, checkInEvent: blockedCheckInEvent };
  }
  if (isBlockedCheckIn) {
    return { status: 'blocked-checkin', event: blockedCheckInEvent };
  }
  if (isBlockedCheckOut) {
    return { status: 'blocked-checkout', event: blockedCheckOutEvent };
  }
  if (isBlockedBetween) {
    return { status: 'blocked', event: blockedActiveEvent };
  }
  
  return { status: 'vacant' };
}

// ==========================================================================
// 4b. 📋 8格精细渐进式着色与交互决策引擎 (Progressive Grid Slot Engine)
// ==========================================================================
/**
 * 核心决策：计算给定日期下，特定房源在 8 个子行槽（0-7）中的渲染色彩与交互属性
 * 1. 普通空闲天：8格全绿 (vacant)
 * 2. 连续入住天：8格全粉 (reserved)
 * 3. 新入住当天：前6格绿 (vacant，等待中)，后2格橘 (checkin，入住后)
 * 4. 退房离店天：前2格蓝 (checkout，退房前)，后6格绿 (vacant，保洁/空置)
 * 5. 同日换客天：前2格蓝 (checkout)，中4格绿 (vacant，保洁窗口！)，后2格橘 (checkin)
 */
function getSlotStatusForDate(propId, dateStr, slotIdx) {
  const fStatus = getPropertyStatusForDate(propId, dateStr);
  const s = fStatus.status;
  
  // A. 普通空闲
  if (s === 'vacant') {
    return { statusClass: 'status-vacant', isBookingCell: false };
  }
  
  // B. 连续连住 (中间日)
  if (s === 'reserved') {
    return { statusClass: 'status-reserved', isBookingCell: false };
  }
  
  // C. 新入住当天 (下午入住，前空后满)
  if (s === 'checkin') {
    if (slotIdx === 6) {
      return { statusClass: 'status-checkin', isBookingCell: true, label: '今日新入住', event: fStatus.event };
    } else if (slotIdx === 7) {
      return { statusClass: 'status-checkin', isBookingCell: false };
    } else {
      // 前 6 格空置，允许写保洁任务
      return { statusClass: 'status-vacant', isBookingCell: false };
    }
  }
  
  // D. 退房当天 (上午退房，前满后空)
  if (s === 'checkout') {
    if (slotIdx === 0) {
      return { statusClass: 'status-checkout', isBookingCell: false };
    } else if (slotIdx === 1) {
      return { statusClass: 'status-checkout', isBookingCell: true, label: '今日退房离店', event: fStatus.event };
    } else {
      // 后 6 格已退房，空置，可写备注
      return { statusClass: 'status-vacant', isBookingCell: false };
    }
  }
  
  // E. 同日交接/换客天 (前退、中空、后入)
  if (s === 'split-out-in') {
    if (slotIdx === 0) {
      return { statusClass: 'status-checkout', isBookingCell: false };
    } else if (slotIdx === 1) {
      return { statusClass: 'status-checkout', isBookingCell: true, label: '今日退房 (换客中)', event: fStatus.checkOutEvent };
    } else if (slotIdx === 6) {
      return { statusClass: 'status-checkin', isBookingCell: true, label: '今日新入住 (换客中)', event: fStatus.checkInEvent };
    } else if (slotIdx === 7) {
      return { statusClass: 'status-checkin', isBookingCell: false };
    } else {
      // 中间 4 个格子为完美保洁空档窗口 (莺绿)
      return { statusClass: 'status-vacant', isBookingCell: false };
    }
  }
  
  // F. 房东锁房/不可用 (8格全灰)
  if (s === 'blocked') {
    if (slotIdx === 0) {
      return { statusClass: 'status-blocked', isBookingCell: true, label: '已锁房/不可用', event: fStatus.event };
    } else {
      return { statusClass: 'status-blocked', isBookingCell: false };
    }
  }
  
  // G. 锁房开始日 (前空后满锁房)
  if (s === 'blocked-checkin') {
    if (slotIdx === 6) {
      return { statusClass: 'status-blocked', isBookingCell: true, label: '今日锁房/不可用', event: fStatus.event };
    } else if (slotIdx === 7) {
      return { statusClass: 'status-blocked', isBookingCell: false };
    } else {
      return { statusClass: 'status-vacant', isBookingCell: false };
    }
  }
  
  // H. 锁房结束日 (前满锁房后空)
  if (s === 'blocked-checkout') {
    if (slotIdx === 0) {
      return { statusClass: 'status-blocked', isBookingCell: false };
    } else if (slotIdx === 1) {
      return { statusClass: 'status-blocked', isBookingCell: true, label: '今日解锁房源', event: fStatus.event };
    } else {
      return { statusClass: 'status-vacant', isBookingCell: false };
    }
  }
  
  // I. 锁房交接日 (前灰、中空、后灰)
  if (s === 'blocked-split') {
    if (slotIdx === 0) {
      return { statusClass: 'status-blocked', isBookingCell: false };
    } else if (slotIdx === 1) {
      return { statusClass: 'status-blocked', isBookingCell: true, label: '今日解锁房源', event: fStatus.checkOutEvent };
    } else if (slotIdx === 6) {
      return { statusClass: 'status-blocked', isBookingCell: true, label: '今日锁房/不可用', event: fStatus.checkInEvent };
    } else if (slotIdx === 7) {
      return { statusClass: 'status-blocked', isBookingCell: false };
    } else {
      return { statusClass: 'status-vacant', isBookingCell: false };
    }
  }
  
  return { statusClass: 'status-vacant', isBookingCell: false };
}

// ==========================================================================
// 5. 数据源拉取与本地备注加载 (Data Loaders)
// ==========================================================================
async function loadData() {
  showSyncButtonLoading(true);
  
  // ⚙️ 优先级 1：优先尝试从云端 Vercel Blob 获取自定义房源配置
  try {
    const cloudConfigRes = await fetch('/api/config?t=' + Date.now());
    if (cloudConfigRes.ok) {
      const cloudConfig = await cloudConfigRes.json();
      if (cloudConfig && Array.isArray(cloudConfig) && cloudConfig.length > 0) {
        state.rawConfig = cloudConfig;
        localStorage.setItem('airbnb_calendar_custom_config', JSON.stringify(cloudConfig));
        console.log('✅ 成功从云端 Vercel Blob 载入房源配置');
      }
    }
  } catch (e) {
    console.warn('⚠️ 从云端载入房源配置失败，将退回本地缓存或默认配置:', e.message);
  }
  
  if (!state.rawConfig || state.rawConfig.length === 0) {
    // 优先级 2：读取 localStorage 自定义品牌房源配置
    const customConfig = localStorage.getItem('airbnb_calendar_custom_config');
    if (customConfig) {
      try {
        state.rawConfig = JSON.parse(customConfig);
        console.log('⚙️ 成功从本地加载自定义房源配置');
      } catch (e) {
        console.error('⚠️ 本地自定义配置解析失败，恢复默认配置。');
        localStorage.removeItem('airbnb_calendar_custom_config');
        state.rawConfig = BRANDS_CONFIG;
      }
    } else {
      // 默认配置
      state.rawConfig = BRANDS_CONFIG;
    }
  }
  
  // ⚙️ 优先级 1：优先尝试从云端 Vercel Blob 获取最新备忘录备注库 (实现全自动数据库驱动)
  try {
    const cloudRemarksRes = await fetch('/api/remarks?t=' + Date.now());
    if (cloudRemarksRes.ok) {
      const cloudRemarks = await cloudRemarksRes.json();
      if (cloudRemarks && typeof cloudRemarks === 'object') {
        // 【数据迁移防护机制】：读取当前本地缓存，如果有本地存在但云端缺失的备注数据，
        // 自动进行静默合并，并自动同步一次回云端数据库，防止更新版本后本地备注被云端空数据擦除覆盖！
        const localRemarks = JSON.parse(localStorage.getItem('airbnb_calendar_remarks')) || {};
        let needMigrationSync = false;
        
        for (const key in localRemarks) {
          if (!cloudRemarks[key]) {
            cloudRemarks[key] = localRemarks[key];
            needMigrationSync = true;
          }
        }
        
        state.remarksData = cloudRemarks;
        localStorage.setItem('airbnb_calendar_remarks', JSON.stringify(state.remarksData));
        console.log('✅ 成功从云端 Vercel Blob 载入最新备注');
        
        if (needMigrationSync) {
          console.log('⏳ 检测到本地存在未同步备注，正在自动将其迁移合并至云端...');
          fetch('/api/remarks', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(state.remarksData)
          }).then(res => {
            if (res.ok) {
              console.log('✅ 本地备注数据一键全自动同步迁移云端成功！');
            } else {
              console.warn('⚠️ 本地备注自动同步迁移失败');
            }
          }).catch(err => {
            console.error('❌ 本地备注自动同步迁移抛出错误:', err);
          });
        }
      }
    } else {
      throw new Error(`HTTP 状态码: ${cloudRemarksRes.status}`);
    }
  } catch (e) {
    console.warn('⚠️ 云端载入备注失败，退回使用本地 LocalStorage 备份:', e.message);
    // 优先级 2：退回到本地 LocalStorage 备份
    state.remarksData = JSON.parse(localStorage.getItem('airbnb_calendar_remarks')) || {};
  }
  
  // 载入本地自定义详情备注 (创建日期, 入住人数)
  state.customBookingDetails = JSON.parse(localStorage.getItem('airbnb_calendar_custom_booking_details')) || {};
  
  // B. 尝试从 localStorage 优先读取日历缓存（实现极速载入，无需等待 Actions JSON 请求）
  const cachedData = localStorage.getItem('airbnb_calendar_data');
  if (cachedData) {
    try {
      const parsed = JSON.parse(cachedData);
      console.log('🚀 命中本地缓存数据');
      applyData(parsed);
    } catch (e) {
      localStorage.removeItem('airbnb_calendar_data');
    }
  }

  try {
    const response = await fetch('data.json?t=' + new Date().getTime());
    if (!response.ok) throw new Error('读取静态日历 JSON 失败');
    const data = await response.json();
    console.log('✅ 成功从静态 data.json 获取最新日程');
    
    // 💡 增量融合本地与服务端数据：
    // 如果本地缓存里有某个房源（比如新添加的房源）且状态为 ok，但服务端 data.json 还没有该房源（或者状态不是 ok），
    // 则将本地缓存中的房源数据融合到服务端数据中，防止刷新后新房源数据被覆盖抹除。
    const cachedDataStr = localStorage.getItem('airbnb_calendar_data');
    if (cachedDataStr) {
      try {
        const cachedData = JSON.parse(cachedDataStr);
        if (cachedData && cachedData.properties) {
          for (const brand of state.rawConfig) {
            for (const prop of brand.properties) {
              const serverProp = data.properties[prop.id];
              const cacheProp = cachedData.properties[prop.id];
              if (cacheProp && cacheProp.status === 'ok') {
                if (!serverProp || serverProp.status !== 'ok') {
                  data.properties[prop.id] = cacheProp;
                  console.log(`💡 从本地缓存融合了房源 [${prop.name}] 的最新日程`);
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn('⚠️ 融合本地缓存与服务端日程失败:', e);
      }
    }
    
    localStorage.setItem('airbnb_calendar_data', JSON.stringify(data));
    applyData(data);
  } catch (error) {
    console.warn('⚠️ 静态 data.json 加载失败，暂不自动启动前端跨域代理实时并发拉取，以防过度刷新...', error);
    if (!cachedData) {
      showToast('⚠️ 未能加载云端日程，请点击“立即更新”拉取最新房态。', 'warning');
    }
  }
  
  showSyncButtonLoading(false);
}

// 辅助等待函数
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 客户端直连抓取备份机制（通过公共跨域代理，结合 staggered delay 规避 429 频控）
async function fetchLiveSyncFallback(useProxyIndex = 0) {
  if (useProxyIndex >= CORS_PROXIES.length) {
    showToast('⚠️ 公共代理响应慢，已为您展示最近一次同步数据（数据十分可靠）', 'warning');
    // 降级尝试加载本地缓存
    const cachedData = localStorage.getItem('airbnb_calendar_data');
    if (cachedData) {
      try {
        applyData(JSON.parse(cachedData));
      } catch (e) {}
    }
    showSyncButtonLoading(false);
    return;
  }
  
  const proxy = CORS_PROXIES[useProxyIndex];
  console.log(`⏳ 正在使用 CORS 代理 [${useProxyIndex}] 实时获取房源 iCal...`);
  showToast('⏳ 正在同步实时房态，请稍候...', 'info');
  
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
  
  const promises = fetchTasks.map(async (task, idx) => {
    try {
      // 渐进式 staggered 延迟排队启动任务，规避代理服务商对并发请求的 429 频控
      if (idx > 0) {
        await sleep(idx * 80);
      }
      const proxiedUrl = proxy(task.ical);
      const res = await fetch(proxiedUrl);
      if (!res.ok) throw new Error(`状态码: ${res.status}`);
      const text = await res.text();
      const events = parseICSClient(text);
      
      const existingProp = state.propertiesData && state.propertiesData[task.propId];
      const existingEvents = existingProp ? existingProp.events : [];
      const mergedEvents = mergeCalendarEvents(existingEvents, events);
      
      fallbackResults.properties[task.propId] = {
        propId: task.propId,
        propName: task.propName,
        brandId: task.brandId,
        events: mergedEvents,
        status: 'ok'
      };
    } catch (e) {
      console.error(`⚠️ 代理抓取房源 [${task.propName}] 失败:`, e.message);
      
      const existingProp = state.propertiesData && state.propertiesData[task.propId];
      const existingEvents = existingProp ? existingProp.events : [];
      
      fallbackResults.properties[task.propId] = {
        propId: task.propId,
        propName: task.propName,
        brandId: task.brandId,
        events: existingEvents,
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
    showToast('🌸 房态数据实时同步已完成！', 'success');
  } catch (err) {
    console.error('💥 备用拉取任务出错，尝试切换下一个 CORS 代理...', err);
    await fetchLiveSyncFallback(useProxyIndex + 1);
  }
}

// 应用并激活拉取到的数据
function applyData(data) {
  state.lastUpdated = data.lastUpdated;
  state.propertiesData = data.properties;
  
  const lastUpdatedTime = state.lastUpdated ? new Date(state.lastUpdated) : new Date();
  const timeString = isNaN(lastUpdatedTime.getTime()) ? '刚刚' : lastUpdatedTime.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  document.getElementById('sync-time-string').innerText = timeString;
  
  renderBrandTabs();
  
  // 确保原选中的品牌依然有效，否则默认选中第一个品牌 Tab
  const brandExists = state.currentBrandId === 'all' || state.rawConfig.some(b => b.id === state.currentBrandId);
  if (!brandExists) {
    state.currentBrandId = state.rawConfig[0]?.id || 'all';
  }
  
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
  
  // 渲染对调后的纵向瀑布流甘特图 (X轴为房源列，Y轴为日期行)
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
// 7. 大盘 KPI 与今日待办事项渲染
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
      <span class="todo-dates">${formatDateDot(event.start)} 至 ${formatDateDot(event.end)}</span>
    </div>
    <div class="todo-item-meta">
      <span class="todo-nights">${nights}晚</span>
      <span class="btn-todo-details" title="查看订单详情">ℹ️</span>
    </div>
  `;
  
  item.querySelector('.btn-todo-details').onclick = () => {
    showBookingModal(propertyName, type === 'checkin' ? '今日新入住' : '今日退房', event);
  };
  return item;
}

// ==========================================================================
// 8. 🔄 瀑布流甘特图与每日 8 格精细着色渲染核心
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
  
  // 1. 构建横向表头 THEAD
  const thead = document.createElement('thead');
  thead.className = 'tg-thead';
  const headerRow = document.createElement('tr');
  
  // 左上角“日期”固位格
  const cornerHeader = document.createElement('th');
  cornerHeader.className = 'tg-col-date-header tg-col-corner';
  cornerHeader.innerText = '日期';
  headerRow.appendChild(cornerHeader);
  
  // 智能前缀剔除：如果在品牌 Tab 下，列头只保留房源短名称，免去冗长前缀
  const activeBrand = state.currentBrandId !== 'all' ? state.rawConfig.find(b => b.id === state.currentBrandId) : null;
  
  activeProps.forEach(p => {
    const propHeader = document.createElement('th');
    propHeader.className = 'tg-col-prop';
    
    let displayName = p.name;
    if (activeBrand) {
      // 智能前缀过滤，如将 “雲町屋 小御” 替换为 “小御”
      const prefixReg = new RegExp(`^${activeBrand.name}\\s*`, 'i');
      displayName = displayName.replace(prefixReg, '').trim();
    }
    propHeader.innerText = displayName;
    headerRow.appendChild(propHeader);
  });
  
  thead.appendChild(headerRow);
  table.appendChild(thead);
  
  // 2. 构建数据表身 TBODY
  const tbody = document.createElement('tbody');
  
  for (let i = 0; i < state.timelineScale; i++) {
    const currentDate = addDays(state.timelineStartDate, i);
    const dateStr = formatDateString(currentDate);
    const dayOfWeek = currentDate.getDay();
    const todayStr = getTodayString();
    
    let dateClass = '';
    if (dateStr === todayStr) {
      dateClass = 'today-date';
    } else if (dayOfWeek === 6) {
      dateClass = 'weekend-sat';
    } else if (dayOfWeek === 0) {
      dateClass = 'weekend-sun';
    }
    
    const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    
    // 每日编译 8 行
    for (let slot = 0; slot < 8; slot++) {
      const tr = document.createElement('tr');
      
      // 特殊底部描边隔离日期
      if (slot === 7) {
        tr.className = 'tg-row-remark tg-row-last-remark';
      } else if (slot === 0) {
        tr.className = 'tg-row-booking';
      } else {
        tr.className = 'tg-row-remark';
      }
      
      // 日期首列 rowspan="8"
      if (slot === 0) {
        const tdDate = document.createElement('td');
        tdDate.className = `tg-col-date-header ${dateClass}`;
        tdDate.setAttribute('data-date-header', dateStr);
        tdDate.rowSpan = 8;
        
        tdDate.innerHTML = `
          <span class="date-name">${dayNames[dayOfWeek]}</span>
          <span class="date-num">${currentDate.getMonth() + 1}/${currentDate.getDate()}</span>
        `;
        tr.appendChild(tdDate);
      }
      
      // 遍历渲染房源列
      activeProps.forEach(p => {
        const td = document.createElement('td');
        
        // 📋 房态色彩决策引擎：获取当前子格 slot 的色彩分类与交互状态
        const slotStatus = getSlotStatusForDate(p.id, dateStr, slot);
        td.className = slotStatus.statusClass;
        
        if (slot === 0) {
          td.classList.add('tg-cell-booking');
        } else {
          td.classList.add('tg-cell-remark');
        }
        
        // 渲染自定义备忘文本
        const remarkKey = `${dateStr}_${p.id}_slot_${slot}`;
        const remarkText = state.remarksData[remarkKey] || '';
        
        // 徽章与备注渲染逻辑
        let innerHtml = '';
        const isCheckoutBadgeSlot = (slot === 1) && (slotStatus.statusClass === 'status-checkout');
        const isCheckinBadgeSlot = (slot === 6) && (slotStatus.statusClass === 'status-checkin');
        
        if (isCheckoutBadgeSlot) {
          innerHtml = `<span class="grid-pill pill-out">退房 <span class="badge-info-icon">ℹ️</span></span>`;
          if (remarkText) {
            innerHtml += ` ` + parseRemarkTextHtml(remarkText);
          }
        } else if (isCheckinBadgeSlot) {
          innerHtml = `<span class="grid-pill pill-in">入住 <span class="badge-info-icon">ℹ️</span></span>`;
          if (remarkText) {
            innerHtml += ` ` + parseRemarkTextHtml(remarkText);
          }
        } else {
          if (remarkText) {
            innerHtml = parseRemarkTextHtml(remarkText);
          } else {
            if (slot === 0) {
              innerHtml = '';
            } else {
              td.classList.add('tg-cell-remark-empty');
              innerHtml = '-';
            }
          }
        }
        
        td.innerHTML = innerHtml;
        
        // 设置数据属性，以便利用事件委托和拖拽判定
        td.dataset.propId = p.id;
        td.dataset.propName = p.name;
        td.dataset.date = dateStr;
        td.dataset.slot = slot;
        
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  }
  table.appendChild(tbody);
  container.appendChild(table);

  // 第一次加载时自动定位到“今天”
  if (state.isFirstLoad) {
    setTimeout(scrollToToday, 50);
    state.isFirstLoad = false;
  }
}

// 自动滚动定位到“今天”
function scrollToToday() {
  const outer = document.querySelector('.timeline-wrapper-outer');
  if (!outer) return;
  const todayEl = outer.querySelector('.today-date');
  if (todayEl) {
    outer.scrollTop = todayEl.offsetTop - (outer.clientHeight / 3);
  }
}

// 自动滚动定位到指定日期
function scrollToDate(dateStr) {
  const outer = document.querySelector('.timeline-wrapper-outer');
  if (!outer) return false;
  const dateEl = outer.querySelector(`[data-date-header="${dateStr}"]`);
  if (dateEl) {
    outer.scrollTop = dateEl.offsetTop - (outer.clientHeight / 3);
    return true;
  }
  return false;
}

// 跳转到任意日期（支持按需重新加载时间轴范围）
function jumpToDate(dateStr) {
  if (!dateStr) return;
  const targetDate = new Date(dateStr);
  if (isNaN(targetDate.getTime())) return;
  
  // 检查目标日期是否在当前已加载的日期范围内
  const start = state.timelineStartDate;
  const end = addDays(start, state.timelineScale);
  
  if (targetDate >= start && targetDate < end) {
    // 已经在加载范围内，直接滚动定位
    scrollToDate(dateStr);
  } else {
    // 超出加载范围，重新以目标日期为中心（前推15天作为起点）进行加载重绘
    state.timelineStartDate = addDays(targetDate, -15);
    state.timelineScale = 60;
    
    renderGanttTimeline(getPropertiesForActiveBrand());
    
    // 延迟等待 DOM 重绘后，执行滚动定位
    setTimeout(() => {
      scrollToDate(dateStr);
    }, 80);
  }
}

// 无限滚动事件处理器
function handleTimelineScroll(container) {
  if (state.isRenderingTimeline) return;
  
  const threshold = 150; // px
  
  // 向下滚动（加载未来）
  if (container.scrollTop + container.clientHeight >= container.scrollHeight - threshold) {
    state.isRenderingTimeline = true;
    state.timelineScale += 15;
    renderGanttTimeline(getPropertiesForActiveBrand());
    state.isRenderingTimeline = false;
  }
  // 向上滚动（加载历史）
  else if (container.scrollTop <= threshold) {
    state.isRenderingTimeline = true;
    const oldScrollHeight = container.scrollHeight;
    const oldScrollTop = container.scrollTop;
    
    state.timelineStartDate = addDays(state.timelineStartDate, -15);
    state.timelineScale += 15;
    
    renderGanttTimeline(getPropertiesForActiveBrand());
    
    const newScrollHeight = container.scrollHeight;
    container.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
    state.isRenderingTimeline = false;
  }
}

function parseRemarkTextHtml(text) {
  if (!text) return '';
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
// 9. ⚙️ 新增房源配置管理器逻辑核心 (Property Config Manager)
// ==========================================================================
function openManagerModal() {
  // 扁平化 rawConfig 导入到工作状态
  state.tempConfigProps = [];
  
  state.rawConfig.forEach(brand => {
    const brandName = brand.name || '';
    if (brand.properties && Array.isArray(brand.properties)) {
      brand.properties.forEach(prop => {
        let fullName = prop.name || '';
        let propName = fullName;
        
        // 分离品牌前缀，例如 "雲町屋 京都駅前" 拆为品牌 "雲町屋" 和房源 "京都駅前"
        if (brandName && fullName.startsWith(brandName)) {
          propName = fullName.substring(brandName.length).trim();
          // 如果带有全角空格，去掉全角空格
          if (propName.startsWith('　')) {
            propName = propName.substring(1).trim();
          }
        }
        
        state.tempConfigProps.push({
          brand: brandName,
          name: propName,
          ical: prop.ical || ''
        });
      });
    }
  });
  
  // 默认设置为表格模式
  state.managerMode = 'table';
  
  const toggleBtn = document.getElementById('btn-manager-toggle-mode');
  if (toggleBtn) {
    toggleBtn.innerText = '📋 切换至 Excel 粘贴模式';
  }
  
  const tableWrapper = document.getElementById('manager-table-wrapper');
  if (tableWrapper) tableWrapper.style.display = 'block';
  
  const textWrapper = document.getElementById('manager-text-wrapper');
  if (textWrapper) textWrapper.style.display = 'none';
  
  const addPropBtn = document.getElementById('btn-manager-add-prop');
  if (addPropBtn) addPropBtn.style.display = 'inline-block';
  
  renderManagerPropertiesList();
  
  document.getElementById('manager-modal').classList.add('active');
}

// 渲染房源配置列表
function renderManagerPropertiesList() {
  const container = document.getElementById('manager-properties-list');
  if (!container) return;
  container.innerHTML = '';
  
  if (state.tempConfigProps.length === 0) {
    container.innerHTML = '<tr><td colspan="4" class="todo-empty" style="text-align: center; padding: 20px;">暂无房源。点击上方 [+ 新增单行房源] 或切换至 [Excel 粘贴模式] 开始添加</td></tr>';
    return;
  }
  
  state.tempConfigProps.forEach((prop, idx) => {
    const tr = document.createElement('tr');
    
    // 1. 品牌名称列
    const tdBrand = document.createElement('td');
    const inputBrand = document.createElement('input');
    inputBrand.type = 'text';
    inputBrand.className = 'manager-text-input';
    inputBrand.value = prop.brand;
    inputBrand.placeholder = '例如: 雲町屋';
    inputBrand.oninput = (e) => {
      prop.brand = e.target.value;
    };
    tdBrand.appendChild(inputBrand);
    
    // 2. 房源名称列
    const tdName = document.createElement('td');
    const inputName = document.createElement('input');
    inputName.type = 'text';
    inputName.className = 'manager-text-input';
    inputName.value = prop.name;
    inputName.placeholder = '例如: 京都駅前';
    inputName.oninput = (e) => {
      prop.name = e.target.value;
    };
    tdName.appendChild(inputName);
    
    // 3. iCal 链接列
    const tdLink = document.createElement('td');
    const inputLink = document.createElement('input');
    inputLink.type = 'text';
    inputLink.className = 'manager-text-input';
    inputLink.value = prop.ical;
    inputLink.placeholder = 'https://www.airbnb.com/calendar/ical/...';
    inputLink.oninput = (e) => {
      prop.ical = e.target.value.trim();
    };
    tdLink.appendChild(inputLink);
    
    // 4. 操作列
    const tdDel = document.createElement('td');
    tdDel.style.textAlign = 'center';
    const delBtn = document.createElement('button');
    delBtn.className = 'btn-manager-row-del';
    delBtn.innerHTML = '&times;';
    delBtn.title = '移除此房源';
    delBtn.onclick = () => {
      state.tempConfigProps.splice(idx, 1);
      renderManagerPropertiesList();
    };
    tdDel.appendChild(delBtn);
    
    tr.appendChild(tdBrand);
    tr.appendChild(tdName);
    tr.appendChild(tdLink);
    tr.appendChild(tdDel);
    container.appendChild(tr);
  });
}

// 切换编辑模式 (表格 <-> Excel粘贴文本框)
function managerToggleMode() {
  const toggleBtn = document.getElementById('btn-manager-toggle-mode');
  const tableWrapper = document.getElementById('manager-table-wrapper');
  const textWrapper = document.getElementById('manager-text-wrapper');
  const addPropBtn = document.getElementById('btn-manager-add-prop');
  
  if (state.managerMode === 'table') {
    // 切换至文本模式，将当前状态序列化为 TSV (Tab 间隔)
    const textRows = state.tempConfigProps.map(p => `${p.brand}\t${p.name}\t${p.ical}`).join('\n');
    document.getElementById('manager-properties-textarea').value = textRows;
    
    tableWrapper.style.display = 'none';
    textWrapper.style.display = 'flex';
    addPropBtn.style.display = 'none';
    toggleBtn.innerText = '📋 切换至 表格编辑模式';
    state.managerMode = 'text';
  } else {
    // 切换回表格模式，先解析文本框内容
    syncTextToProps();
    renderManagerPropertiesList();
    
    tableWrapper.style.display = 'block';
    textWrapper.style.display = 'none';
    addPropBtn.style.display = 'inline-block';
    toggleBtn.innerText = '📋 切换至 Excel 粘贴模式';
    state.managerMode = 'table';
  }
}

// 解析文本框内容到内存状态中
function syncTextToProps() {
  if (state.managerMode !== 'text') return;
  const text = document.getElementById('manager-properties-textarea').value;
  const lines = text.split('\n');
  state.tempConfigProps = [];
  
  lines.forEach(line => {
    const cleaned = line.trim();
    if (!cleaned) return;
    
    // 优先采用 Excel 复制出来的 Tab 键分割
    let parts = cleaned.split('\t');
    if (parts.length < 3) {
      // 备用：两个或两个以上空格
      parts = cleaned.split(/\s{2,}/);
      if (parts.length < 3) {
        // 备用：普通空格
        parts = cleaned.split(/\s+/);
      }
    }
    
    if (parts.length >= 3) {
      state.tempConfigProps.push({
        brand: parts[0].trim(),
        name: parts[1].trim(),
        ical: parts.slice(2).join(' ').trim()
      });
    } else if (parts.length === 2) {
      state.tempConfigProps.push({
        brand: parts[0].trim(),
        name: parts[1].trim(),
        ical: ''
      });
    } else if (parts.length === 1) {
      state.tempConfigProps.push({
        brand: parts[0].trim(),
        name: '',
        ical: ''
      });
    }
  });
}

// 新增单行房源
function managerAddProperty() {
  state.tempConfigProps.push({
    brand: '',
    name: '',
    ical: ''
  });
  renderManagerPropertiesList();
  
  // 滚动到底部以展示新添加的行
  setTimeout(() => {
    const wrapper = document.getElementById('manager-table-wrapper');
    if (wrapper) wrapper.scrollTop = wrapper.scrollHeight;
  }, 50);
}

// 将扁平化属性列表编译为层次化的 BRANDS_CONFIG 结构
function compileTempConfig() {
  syncTextToProps();
  
  const newBrandsConfig = [];
  const brandMap = new Map();
  
  state.tempConfigProps.forEach(item => {
    const brandName = item.brand.trim();
    const propName = item.name.trim();
    const ical = item.ical.trim();
    
    if (!brandName || !propName) return; // 过滤不完整数据
    
    // 如果该品牌尚未在 map 中，初始化它
    if (!brandMap.has(brandName)) {
      // 从原有的 rawConfig 查找，尽可能保留品牌 Icon 和固定 ID (比如 "yunmachiya" 对应 "🌸")
      const existingBrand = state.rawConfig.find(b => b.name === brandName);
      const brandId = existingBrand ? existingBrand.id : 'brand_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
      const icon = existingBrand ? existingBrand.icon : '🏨';
      
      const brandObj = {
        id: brandId,
        name: brandName,
        icon: icon,
        properties: []
      };
      brandMap.set(brandName, brandObj);
      newBrandsConfig.push(brandObj);
    }
    
    // 查找该房源是否已经存在，尽可能保留其原始 ID，防止 localStorage 绑定的运营备注、入住人数等数据丢失
    let propId = '';
    const fullName = brandName + ' ' + propName;
    
    let existingProp = null;
    for (const b of state.rawConfig) {
      for (const p of b.properties) {
        if (p.ical === ical) {
          existingProp = p;
          break;
        }
        if (p.name === fullName || p.name.replace(/\s+/g, '') === fullName.replace(/\s+/g, '')) {
          existingProp = p;
          break;
        }
      }
      if (existingProp) break;
    }
    
    if (existingProp) {
      propId = existingProp.id;
    } else {
      propId = 'prop_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    }
    
    brandMap.get(brandName).properties.push({
      id: propId,
      name: fullName,
      ical: ical
    });
  });
  
  return newBrandsConfig;
}

// 保存并应用管理器配置
function managerSave() {
  const newBrandsConfig = compileTempConfig();
  
  if (newBrandsConfig.length === 0) {
    showToast('❌ 请至少配置一个有效的房源信息！', 'error');
    return;
  }
  
  // 校验 iCal 订阅链接
  for (const b of newBrandsConfig) {
    for (const p of b.properties) {
      if (!p.ical.trim()) {
        showToast(`❌ 房源 [${p.name}] 的 Airbnb ics 订阅链接不能为空！`, 'error');
        return;
      }
    }
  }
  
  state.rawConfig = newBrandsConfig;
  
  // 持久化存储于本地 localStorage 数据库
  localStorage.setItem('airbnb_calendar_custom_config', JSON.stringify(state.rawConfig));
  
  hideManagerModal();
  
  // 重新渲染全部 Tab 与甘特图视图
  applyData({
    lastUpdated: state.lastUpdated,
    properties: state.propertiesData
  });
  
  showToast('💾 房源配置已成功保存并在本地应用！正在同步至云端，请稍候...', 'info');
  
  // 异步同步房源配置至云端 Vercel Blob
  syncConfigToCloud();
}

// 恢复默认初始配置
function managerReset() {
  if (confirm('🗑️ 确定要清空所有自定义房源，恢复为最初的 [雲町屋 14个房源] 默认配置吗？\n此操作将擦除您的所有本地修改！')) {
    localStorage.removeItem('airbnb_calendar_custom_config');
    state.rawConfig = BRANDS_CONFIG;
    hideManagerModal();
    applyData({
      lastUpdated: state.lastUpdated,
      properties: state.propertiesData
    });
    showToast('✅ 已顺利恢复默认初始配置！正在同步至云端，请稍候...', 'info');
    
    // 同步默认配置至云端 Vercel Blob
    syncConfigToCloud();
  }
}

// 一键复制并编译当前配置为 config.js 文件内容
function managerCopyCode() {
  const newBrandsConfig = compileTempConfig();
  
  if (newBrandsConfig.length === 0) {
    showToast('❌ 无有效配置，请先添加房源！', 'error');
    return;
  }
  
  const compiledCode = `/**\n * 雲町屋 & 多品牌房源日历配置文件 (Config.js)\n * 由配置管理器自动编译生成\n */\n\nconst BRANDS_CONFIG = ${JSON.stringify(newBrandsConfig, null, 2)};\n\nif (typeof module !== 'undefined' && module.exports) {\n  module.exports = { BRANDS_CONFIG };\n}\n`;
  
  navigator.clipboard.writeText(compiledCode).then(() => {
    showToast('📋 config.js 代码已复制！请粘贴到本地文件并 git push 即可。', 'success');
  }).catch(err => {
    console.error('复制失败:', err);
    showToast('❌ 复制失败，请在控制台手动复制。', 'error');
  });
}

function hideManagerModal() {
  document.getElementById('manager-modal').classList.remove('active');
}

// ==========================================================================
// 10. 备忘录编辑弹窗控制
// ==========================================================================
function openRemarksModal(propId, propName, dateStr, slotIdx) {
  state.remarksActivePropId = propId;
  state.remarksActiveDate = dateStr;
  state.remarksActiveSlotIdx = slotIdx;
  
  document.getElementById('remarks-modal-prop-name').innerText = propName;
  document.getElementById('remarks-modal-date').innerText = formatDateChinese(dateStr);
  document.getElementById('remarks-modal-slot-id').innerText = `第 ${slotIdx} 行备注槽`;
  
  const remarkKey = `${dateStr}_${propId}_slot_${slotIdx}`;
  const existing = state.remarksData[remarkKey] || '';
  
  let tag = '';
  let textVal = existing;
  
  const match = existing.match(/^(🔧 维修|🚒 消防|📦 配送|👥 人数|💬 需求)\s*(.*)$/);
  if (match) {
    tag = match[1];
    textVal = match[2];
  }
  
  state.remarksActiveTag = tag;
  document.getElementById('input-remark-text').value = textVal;
  updateRemarksTagHighlight();
  
  document.getElementById('remarks-modal').classList.add('active');
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

async function saveRemarks() {
  const textVal = document.getElementById('input-remark-text').value.trim();
  const key = `${state.remarksActiveDate}_${state.remarksActivePropId}_slot_${state.remarksActiveSlotIdx}`;
  
  // 备份旧状态以备同步失败时回滚
  const oldRemarks = Object.assign({}, state.remarksData);
  
  if (textVal === '') {
    delete state.remarksData[key];
  } else {
    const fullText = state.remarksActiveTag ? `${state.remarksActiveTag} ${textVal}` : textVal;
    state.remarksData[key] = fullText;
  }
  
  showToast('⏳ 正在同步备注至云端数据库...', 'info');
  
  try {
    await syncRemarksToCloud();
    // 云端保存成功，更新本地 LocalStorage 备份
    localStorage.setItem('airbnb_calendar_remarks', JSON.stringify(state.remarksData));
    hideRemarksModal();
    renderGanttTimeline(getPropertiesForActiveBrand());
    showToast('💾 备注已成功同步至云端数据库！', 'success');
  } catch (e) {
    // 失败则回滚内存状态，展示报错
    state.remarksData = oldRemarks;
    console.error('❌ 备注云端同步失败:', e.message);
    showToast(`❌ 备注同步失败: ${e.message}。修改未保存，请重试！`, 'error');
  }
}

async function deleteRemark() {
  const key = `${state.remarksActiveDate}_${state.remarksActivePropId}_slot_${state.remarksActiveSlotIdx}`;
  
  // 备份旧状态以备同步失败时回滚
  const oldRemarks = Object.assign({}, state.remarksData);
  
  delete state.remarksData[key];
  
  showToast('⏳ 正在从云端删除备注...', 'info');
  
  try {
    await syncRemarksToCloud();
    // 云端删除成功，更新本地 LocalStorage 备份
    localStorage.setItem('airbnb_calendar_remarks', JSON.stringify(state.remarksData));
    hideRemarksModal();
    renderGanttTimeline(getPropertiesForActiveBrand());
    showToast('🗑️ 备注已成功从云端删除！', 'success');
  } catch (e) {
    // 失败则回滚内存状态，展示报错
    state.remarksData = oldRemarks;
    console.error('❌ 从云端删除备注失败:', e.message);
    showToast(`❌ 删除失败: ${e.message}。修改未应用，请重试！`, 'error');
  }
}

async function syncRemarksToCloud() {
  const res = await fetch('/api/remarks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(state.remarksData)
  });
  if (res.ok) {
    console.log('✅ 备注成功同步至 Vercel Blob 云端');
  } else {
    let errMsg = `HTTP 状态码: ${res.status}`;
    try {
      const errJson = await res.json();
      if (errJson && errJson.error) {
        errMsg = errJson.error;
      }
    } catch (jsonErr) {}
    throw new Error(errMsg);
  }
}

async function syncConfigToCloud() {
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(state.rawConfig)
    });
    if (res.ok) {
      console.log('✅ 房源配置成功同步至 Vercel Blob 云端');
      showToast('🌸 房源配置已成功同步到云端！数据将在下次定时同步时自动载入。', 'success');
    } else {
      let errMsg = `HTTP 状态码: ${res.status}`;
      try {
        const errJson = await res.json();
        if (errJson && errJson.error) {
          errMsg = errJson.error;
        }
      } catch (jsonErr) {}
      throw new Error(errMsg);
    }
  } catch (e) {
    console.error('⚠️ 房源配置同步云端失败，但已保存在当前浏览器:', e.message);
    showToast(`⚠️ 房源配置同步云端失败 (${e.message})，已保存在当前浏览器`, 'warning');
  }
}

function hideRemarksModal() {
  document.getElementById('remarks-modal').classList.remove('active');
}

// ==========================================================================
// 11. 单房源月度精细日历渲染
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
  document.getElementById('sidebar-brand-name').innerText = getBrandNameForProperty(propId);
  
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

function getBrandNameForProperty(propIdOrName) {
  for (const b of state.rawConfig) {
    const found = b.properties.some(p => p.id === propIdOrName || p.name === propIdOrName);
    if (found) return b.name;
  }
  return '其他品牌';
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
          td.style.backgroundColor = '#CDE6D0';
          statusStripeHtml = `<div class="cal-booking-stripe" style="color: #194D25">🎋 已占用</div>`;
          td.onclick = () => showBookingModal(getPropertyById(propId).name, '已入住/占用', fStatus.event);
        } else if (fStatus.status === 'blocked' || fStatus.status === 'blocked-checkin' || fStatus.status === 'blocked-checkout' || fStatus.status === 'blocked-split') {
          td.style.backgroundColor = '#E8E4D9';
          statusStripeHtml = `<div class="cal-booking-stripe" style="color: #8C8475">🔒 锁房/不可用</div>`;
          td.onclick = () => showBookingModal(getPropertyById(propId).name, '已锁房/不可用', fStatus.event || fStatus.checkInEvent || fStatus.checkOutEvent);
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
  
  const sortedEvents = [...prop.events]
    .filter(ev => isReservationEvent(ev))
    .sort((a,b) => new Date(a.start) - new Date(b.start));
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
// 12. 预订详情与双客交错弹窗控制
// ==========================================================================
function showBookingModal(propertyName, statusText, event) {
  const modal = document.getElementById('booking-modal');
  document.getElementById('modal-prop-name').innerText = propertyName;
  
  const statusEl = document.getElementById('modal-status');
  statusEl.innerText = statusText;
  statusEl.className = 'field-value';
  
  const isReal = isReservationEvent(event);
  const titleEl = document.querySelector('#booking-modal .modal-header h3');
  if (titleEl) {
    titleEl.innerText = isReal ? '📄 房态预订详情' : '🔒 房态锁定详情';
  }
  
  if (!isReal) {
    statusEl.style.color = '#8C8475';
    statusEl.innerText = '房东锁房/系统锁定';
  } else if (statusText.includes('入住')) {
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
  
  const createdDateRow = document.getElementById('modal-field-created-date');
  const guestsRow = document.getElementById('modal-field-guests');
  const hintRow = document.getElementById('modal-field-hint');
  
  if (isReal) {
    createdDateRow.style.display = 'flex';
    guestsRow.style.display = 'flex';
    hintRow.style.display = 'block';
    
    // 重置输入框与文本展示状态
    const createdDateInput = document.getElementById('modal-created-date-input');
    const createdDateSpan = document.getElementById('modal-created-date');
    const editCreatedDateBtn = document.getElementById('btn-edit-created-date');
    createdDateInput.style.display = 'none';
    createdDateSpan.style.display = 'inline';
    editCreatedDateBtn.innerText = '✏️';
    
    const guestsInput = document.getElementById('modal-guests-input');
    const guestsSpan = document.getElementById('modal-guests');
    const editGuestsBtn = document.getElementById('btn-edit-guests');
    guestsInput.style.display = 'none';
    guestsSpan.style.display = 'inline';
    editGuestsBtn.innerText = '✏️';
    
    state.activeModalEventUid = event.uid;
    
    // 展示当前保存的值
    const details = state.customBookingDetails[event.uid] || {};
    if (details.createdDate) {
      createdDateSpan.innerText = formatDateChinese(details.createdDate);
      createdDateSpan.style.color = '';
      createdDateSpan.style.fontStyle = '';
      createdDateSpan.style.fontSize = '';
    } else {
      createdDateSpan.innerText = 'iCal未提供 (可点击编辑)';
      createdDateSpan.style.color = 'var(--text-muted)';
      createdDateSpan.style.fontStyle = 'italic';
      createdDateSpan.style.fontSize = '0.85rem';
    }
    
    if (details.guests) {
      guestsSpan.innerText = `${details.guests} 人`;
      guestsSpan.style.color = '';
      guestsSpan.style.fontStyle = '';
      guestsSpan.style.fontSize = '';
    } else {
      guestsSpan.innerText = 'iCal未提供 (可点击编辑)';
      guestsSpan.style.color = 'var(--text-muted)';
      guestsSpan.style.fontStyle = 'italic';
      guestsSpan.style.fontSize = '0.85rem';
    }
  } else {
    createdDateRow.style.display = 'none';
    guestsRow.style.display = 'none';
    hintRow.style.display = 'none';
    state.activeModalEventUid = '';
  }
  
  const phoneRow = document.getElementById('modal-field-phone');
  const linkRow = document.getElementById('modal-field-link');

  if (isReal && event.phoneLast4) {
    phoneRow.style.display = 'flex';
    document.getElementById('modal-phone').innerText = `*** - **** - ${event.phoneLast4}`;
  } else {
    phoneRow.style.display = 'none';
  }
  
  if (isReal && event.reservationUrl) {
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
// 13. 控制监听与程序初始化 (Event Handlers & Bootstrapper)
// ==========================================================================
function setupEventListeners() {
  const inputJumpDate = document.getElementById('input-jump-date');

  // 1. 回到今天（重置展示时间跨度为：30天前 到 30天后，共60天）
  document.getElementById('btn-time-today').onclick = () => {
    const today = new Date();
    state.timelineStartDate = addDays(today, -30);
    state.timelineScale = 60;
    renderGanttTimeline(getPropertiesForActiveBrand());
    scrollToToday();
    if (inputJumpDate) {
      inputJumpDate.value = '';
    }
  };
  
  // 1b. 选择任意日期跳转
  if (inputJumpDate) {
    inputJumpDate.onchange = (e) => {
      jumpToDate(e.target.value);
    };
  }
  
  // 🔍 2. 放大看板切换
  const btnToggleFullscreen = document.getElementById('btn-toggle-fullscreen');
  if (btnToggleFullscreen) {
    btnToggleFullscreen.onclick = () => {
      const section = document.querySelector('.timeline-section');
      if (section) {
        const isFull = section.classList.toggle('fullscreen-mode');
        btnToggleFullscreen.innerHTML = isFull ? '🔍 恢复常规视图' : '🔍 放大每日看板';
        setTimeout(scrollToToday, 50);
      }
    };
  }
  
  // 🤝 3. 拖动及点击代理手势系统 与 无限滚动监听
  const outerContainer = document.querySelector('.timeline-wrapper-outer');
  if (outerContainer) {
    // 3.1 纵向无限滚动监听
    let isScrolling = false;
    outerContainer.addEventListener('scroll', () => {
      if (isScrolling) return;
      isScrolling = true;
      requestAnimationFrame(() => {
        handleTimelineScroll(outerContainer);
        isScrolling = false;
      });
    });

    // 3.2 鼠标拖拽平滑横纵移动表格
    let isDown = false;
    let startX, startY;
    let scrollLeft, scrollTop;
    let moved = false;

    outerContainer.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // 仅限左键
      if (e.target.closest('button') || e.target.closest('input') || e.target.closest('textarea') || e.target.closest('a')) return;
      
      isDown = true;
      outerContainer.classList.add('grabbing');
      startX = e.pageX - outerContainer.offsetLeft;
      startY = e.pageY - outerContainer.offsetTop;
      scrollLeft = outerContainer.scrollLeft;
      scrollTop = outerContainer.scrollTop;
      moved = false;
    });

    outerContainer.addEventListener('mouseleave', () => {
      if (isDown) {
        isDown = false;
        outerContainer.classList.remove('grabbing');
      }
    });

    outerContainer.addEventListener('mouseup', () => {
      if (isDown) {
        isDown = false;
        outerContainer.classList.remove('grabbing');
      }
    });

    outerContainer.addEventListener('mousemove', (e) => {
      if (!isDown) return;
      e.preventDefault();
      const x = e.pageX - outerContainer.offsetLeft;
      const y = e.pageY - outerContainer.offsetTop;
      const walkX = (x - startX) * 1.5;
      const walkY = (y - startY) * 1.5;
      
      if (Math.abs(walkX) > 4 || Math.abs(walkY) > 4) {
        moved = true;
      }
      
      outerContainer.scrollLeft = scrollLeft - walkX;
      outerContainer.scrollTop = scrollTop - walkY;
    });

    // 3.3 利用事件委托，避开拖拽干扰
    outerContainer.addEventListener('click', (e) => {
      if (moved) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      
      const td = e.target.closest('td');
      if (!td) return;
      
      const propId = td.dataset.propId;
      const propName = td.dataset.propName;
      const dateStr = td.dataset.date;
      const slot = td.dataset.slot;
      if (!propId || !dateStr || slot === undefined) return;
      
      const slotIdx = parseInt(slot, 10);
      const slotStatus = getSlotStatusForDate(propId, dateStr, slotIdx);
      if (slotStatus.isBookingCell) {
        showBookingModal(propName, slotStatus.label, slotStatus.event);
      } else {
        openRemarksModal(propId, propName, dateStr, slotIdx);
      }
    });
  }
  
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
  
  // 6b. 订单创建日期与人数的本地编辑交互
  document.getElementById('btn-edit-created-date').onclick = () => {
    const uid = state.activeModalEventUid;
    if (!uid) return;
    
    const span = document.getElementById('modal-created-date');
    const input = document.getElementById('modal-created-date-input');
    const btn = document.getElementById('btn-edit-created-date');
    
    const isEditing = input.style.display !== 'none';
    if (isEditing) {
      // 保存
      const newVal = input.value.trim();
      if (!state.customBookingDetails[uid]) {
        state.customBookingDetails[uid] = {};
      }
      state.customBookingDetails[uid].createdDate = newVal;
      localStorage.setItem('airbnb_calendar_custom_booking_details', JSON.stringify(state.customBookingDetails));
      
      // 更新UI展示
      input.style.display = 'none';
      span.style.display = 'inline';
      btn.innerText = '✏️';
      
      if (newVal) {
        span.innerText = formatDateChinese(newVal);
        span.style.color = '';
        span.style.fontStyle = '';
        span.style.fontSize = '';
      } else {
        span.innerText = 'iCal未提供 (可点击编辑)';
        span.style.color = 'var(--text-muted)';
        span.style.fontStyle = 'italic';
        span.style.fontSize = '0.85rem';
      }
      
      showToast('订单创建日期保存成功', 'success');
    } else {
      // 进入编辑状态
      const currVal = (state.customBookingDetails[uid] && state.customBookingDetails[uid].createdDate) || '';
      input.value = currVal;
      
      span.style.display = 'none';
      input.style.display = 'inline-block';
      btn.innerText = '💾';
      input.focus();
    }
  };
  
  document.getElementById('btn-edit-guests').onclick = () => {
    const uid = state.activeModalEventUid;
    if (!uid) return;
    
    const span = document.getElementById('modal-guests');
    const input = document.getElementById('modal-guests-input');
    const btn = document.getElementById('btn-edit-guests');
    
    const isEditing = input.style.display !== 'none';
    if (isEditing) {
      // 保存
      const newVal = parseInt(input.value.trim(), 10);
      if (!state.customBookingDetails[uid]) {
        state.customBookingDetails[uid] = {};
      }
      
      if (isNaN(newVal) || newVal <= 0) {
        delete state.customBookingDetails[uid].guests;
      } else {
        state.customBookingDetails[uid].guests = newVal;
      }
      localStorage.setItem('airbnb_calendar_custom_booking_details', JSON.stringify(state.customBookingDetails));
      
      // 更新UI展示
      input.style.display = 'none';
      span.style.display = 'inline';
      btn.innerText = '✏️';
      
      const savedVal = state.customBookingDetails[uid] ? state.customBookingDetails[uid].guests : null;
      if (savedVal) {
        span.innerText = `${savedVal} 人`;
        span.style.color = '';
        span.style.fontStyle = '';
        span.style.fontSize = '';
      } else {
        span.innerText = 'iCal未提供 (可点击编辑)';
        span.style.color = 'var(--text-muted)';
        span.style.fontStyle = 'italic';
        span.style.fontSize = '0.85rem';
      }
      
      showToast('入住人数保存成功', 'success');
    } else {
      // 进入编辑状态
      const currVal = (state.customBookingDetails[uid] && state.customBookingDetails[uid].guests) || '';
      input.value = currVal;
      
      span.style.display = 'none';
      input.style.display = 'inline-block';
      btn.innerText = '💾';
      input.focus();
    }
  };
  
  // 7. 备忘录编辑弹窗关闭与动作
  document.getElementById('btn-close-remarks-modal').onclick = hideRemarksModal;
  document.getElementById('btn-cancel-remarks').onclick = hideRemarksModal;
  document.getElementById('btn-save-remarks').onclick = saveRemarks;
  document.getElementById('btn-delete-remark').onclick = deleteRemark;
  
  const tagButtons = document.querySelectorAll('.type-buttons .btn-type-tag');
  tagButtons.forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      state.remarksActiveTag = btn.getAttribute('data-tag');
      updateRemarksTagHighlight();
    };
  });
  
  document.getElementById('remarks-modal').onclick = (e) => {
    if (e.target.id === 'remarks-modal') hideRemarksModal();
  };
  
  // ⚙️ 8. 房源管理器弹窗动作交互绑定
  document.getElementById('btn-open-manager').onclick = openManagerModal;
  document.getElementById('btn-close-manager-modal').onclick = hideManagerModal;
  document.getElementById('btn-manager-save').onclick = managerSave;
  document.getElementById('btn-manager-reset').onclick = managerReset;
  document.getElementById('btn-manager-copy-code').onclick = managerCopyCode;
  document.getElementById('btn-manager-toggle-mode').onclick = managerToggleMode;
  document.getElementById('btn-manager-add-prop').onclick = managerAddProperty;
  

  
  document.getElementById('manager-modal').onclick = (e) => {
    if (e.target.id === 'manager-modal') hideManagerModal();
  };
}

// 主启动引导程序
function init() {
  console.log('🌸 正在初始化日系纵向房态与排班备忘大盘...');
  
  const today = new Date();
  state.timelineStartDate = addDays(today, -30);
  state.timelineScale = 60;
  state.calendarYear = today.getFullYear();
  state.calendarMonth = today.getMonth();
  
  setupEventListeners();
  loadData();
}

// 启动大盘！
window.onload = init;

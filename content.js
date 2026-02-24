// ====== PlayBeautyStreet Helper: copy comments with Taiwan time (v2 scan+intercept) ======
(() => {
  // ---------- Config ----------
  const WAIT_TIME = 300;
  const MAX_RETRY = 30;
  const MAX_TIME = 10000;

  // ---------- Utils ----------
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const pad = n => String(n).padStart(2,'0');

  // ---------- Dialog 精確定位 ----------
  // FB 動態牆背景存在 26~29 個 [role="dialog"]，其中一個有 article 但無關閉按鈕（feed 容器）
  // 必須同時要求「有 article」+ 「有關閉按鈕」才算貼文 modal
  function hasCloseBtn(d) {
    return Array.from(d.querySelectorAll('[aria-label]'))
      .some(el => /^關閉$|^Close$/.test((el.getAttribute('aria-label') || '').trim()));
  }

  function getPostDialog() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
      .filter(d => !d.closest('[role="banner"]'));
    // 優先：有 article 且有關閉按鈕（貼文 modal 完整載入）
    const full = dialogs.find(d => d.querySelector('[role="article"]') && hasCloseBtn(d));
    if (full) return full;
    // 次優：只有關閉按鈕（modal 剛出現、留言未載入）
    return dialogs.find(d => hasCloseBtn(d)) || null;
  }

  // DFS 找最大可捲動容器（替代固定的 children 路徑）
  function findScrollContainer(dialog) {
    if (!dialog) return null;
    let best = null, bestH = 0;
    function walk(el, depth) {
      if (depth > 10) return;
      const oy = window.getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 50) {
        if (el.scrollHeight > bestH) { best = el; bestH = el.scrollHeight; }
      }
      for (const c of el.children) walk(c, depth + 1);
    }
    walk(dialog, 0);
    return best;
  }

  function normalizeCommentId(raw) {
    if (raw == null) return null;
    let value = raw;
    if (typeof value === 'number') value = String(value);
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) return trimmed;

    // comment:POSTID_COMMENTID 格式
    const underscoreMatch = trimmed.match(/_(\d+)$/);
    if (underscoreMatch) return underscoreMatch[1];

    // base64 編碼 (常見格式: comment:POSTID_COMMENTID)
    if (trimmed.includes('=')) {
      try {
        const decoded = atob(trimmed);
        const match = decoded.match(/_(\d+)$/);
        if (match) return match[1];
      } catch {}
    }

    return null;
  }

  function harvestCreatedTimesFromRelayStore() {
    try {
      if (typeof require !== 'function') return;
      const CometRelayEnvironment = require('CometRelayEnvironment');
      const CurrentUserInitialData = require('CurrentUserInitialData');
      const actorId = CurrentUserInitialData?.ACCOUNT_ID ?? null;
      const multi = CometRelayEnvironment?.multiActorEnvironment;
      const relayEnv = multi?.forActor?.(actorId) ?? CometRelayEnvironment;
      const store = relayEnv?.getStore?.();
      const source = store?.getSource?.();
      const recordIDs = source?.getRecordIDs?.();
      if (!recordIDs || typeof source.get !== 'function') return;

      for (const recordId of recordIDs) {
        const record = source.get(recordId);
        if (!record || typeof record !== 'object') continue;
        const legacy = record.legacy_fbid ?? record.id;
        const createdTime = record.created_time ?? record.creation_time ?? record.comment_creation_time;
        if (legacy == null || createdTime == null) continue;
        const normalized = normalizeCommentId(legacy);
        const sec = Number(createdTime);
        if (normalized && !Number.isNaN(sec) && sec > 0) {
          createdTimeMap.set(normalized, sec);
          createdTimeMap.set(String(legacy), sec);
        }
      }
    } catch (err) {
      console.warn('harvest relay store failed', err);
    }
  }

  function showToast(msg) {
    let toast = document.createElement('div');
    toast.innerText = msg;
    Object.assign(toast.style, {
      position: 'fixed', top: '50%', left: '50%',
      transform: 'translate(-50%, -50%)',
      background: 'rgba(60,60,60,0.95)', color: '#fff',
      padding: '16px 28px', borderRadius: '8px',
      fontSize: '18px', fontWeight: 'bold', zIndex: '99999',
      boxShadow: '0 4px 16px rgba(0,0,0,0.25)', opacity: '0',
      transition: 'opacity 0.2s'
    });
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.style.opacity = '1');
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 1500);
  }

  // ---------- Created-time collector ----------
  const createdTimeMap = new Map(); // key: comment legacy_fbid/id (string), value: epoch seconds (number)

  function recordCreatedTimeMaybe(obj) {
    if (!obj || typeof obj !== 'object') return;

    // 一般扁平欄位
    const idLike = obj.legacy_fbid ?? obj.id ?? obj.commentid;
    const secLike = obj.created_time ?? obj.creation_time ?? obj.comment_creation_time;
    if (idLike != null && secLike != null) {
      const normalized = normalizeCommentId(idLike);
      const sec = Number(secLike);
      if (!Number.isNaN(sec) && sec > 0) {
        if (normalized) createdTimeMap.set(normalized, sec);
        createdTimeMap.set(String(idLike), sec);
      }
    }

    // 你貼的結構：comment_action_links[].comment.{ legacy_fbid/id, created_time }
    if (Array.isArray(obj.comment_action_links)) {
      for (const link of obj.comment_action_links) {
        const c = link?.comment;
        if (c && typeof c.created_time === 'number' && c.created_time > 0) {
          // 嘗試從多個來源提取數字 ID
          let numericId = normalizeCommentId(c.legacy_fbid ?? c.id);

          // 如果有 URL,從 URL 中提取 comment_id
          if (!numericId && c.url && typeof c.url === 'string') {
            const match = c.url.match(/comment_id=(\d+)/);
            if (match) numericId = match[1];
          }

          if (numericId) {
            createdTimeMap.set(numericId, c.created_time);
          }
          if (c.id) createdTimeMap.set(String(c.id), c.created_time);
        }
      }
    }
  }

  function harvestCreatedTimesFromJSON(obj) {
    try {
      recordCreatedTimeMaybe(obj);
      for (const k in obj) {
        const v = obj[k];
        if (v && typeof v === 'object') harvestCreatedTimesFromJSON(v);
      }
    } catch {}
  }

  // 立刻掃描頁面所有 <script> 的 JSON 內容
  function scanAllScriptsForJSON() {
    const scripts = Array.from(document.querySelectorAll('script'));
    for (const s of scripts) {
      const txt = s.textContent?.trim();
      if (!txt) continue;

      // 可能是 JSONL/分行 JSON
      const lines = txt.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const j = JSON.parse(line);
          harvestCreatedTimesFromJSON(j);
        } catch {}
      }
      // 也嘗試整段 parse（不少是完整 JSON）
      try {
        const j = JSON.parse(txt);
        harvestCreatedTimesFromJSON(j);
      } catch {}
    }
    harvestCreatedTimesFromRelayStore();
  }

  // 攔截 fetch - 增強版,延遲處理確保 JSON 完整
  const _fetch = window.fetch;
  window.fetch = async function(...args) {
    const res = await _fetch.apply(this, args);
    
    // 非同步處理回應,不阻塞請求
    (async () => {
      try {
        const clone = res.clone();
        const ct = clone.headers.get('content-type') || '';
        if (ct.includes('application/json') || ct.includes('text/javascript')) {
          const text = await clone.text();
          
          // 處理多行 JSON (JSONL 格式)
          const pieces = text.split('\n').filter(Boolean);
          for (const p of pieces) { 
            try { 
              const parsed = JSON.parse(p);
              harvestCreatedTimesFromJSON(parsed);
            } catch {} 
          }
          
          // 也嘗試整體解析
          try { 
            const parsed = JSON.parse(text);
            harvestCreatedTimesFromJSON(parsed);
          } catch {}
          
          // 延遲 100ms 再從 Relay Store 收集一次
          await new Promise(r => setTimeout(r, 100));
          harvestCreatedTimesFromRelayStore();
        }
      } catch (err) {
        console.warn('[PlayBeautyStreet] fetch interceptor error:', err);
      }
    })();
    
    return res;
  };

  // 攔截 XHR - 增強版
  (function patchXHR(){
    const _open = XMLHttpRequest.prototype.open;
    const _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(...args){
      this._url = args[1];
      return _open.apply(this, args);
    };
    XMLHttpRequest.prototype.send = function(...args){
      this.addEventListener('load', async function(){
        try {
          const ct = this.getResponseHeader('content-type') || '';
          if (ct.includes('application/json') || ct.includes('text/javascript')) {
            const text = this.responseText || '';
            
            // 處理多行 JSON
            const pieces = text.split('\n').filter(Boolean);
            for (const p of pieces) { 
              try { 
                const parsed = JSON.parse(p);
                harvestCreatedTimesFromJSON(parsed);
              } catch {} 
            }
            
            // 整體解析
            try { 
              const parsed = JSON.parse(text);
              harvestCreatedTimesFromJSON(parsed);
            } catch {}
            
            // 延遲 100ms 再從 Relay Store 收集
            await new Promise(r => setTimeout(r, 100));
            harvestCreatedTimesFromRelayStore();
          }
        } catch (err) {
          console.warn('[PlayBeautyStreet] XHR interceptor error:', err);
        }
      });
      return _send.apply(this, args);
    };
  })();

  // ---------- Time formatters ----------
  function isoUTCFromEpoch(sec){
    try { return new Date(sec * 1000).toISOString().replace('.000Z','Z'); } catch { return ""; }
  }
  function isoTaipeiFromEpoch(sec){
    try {
      const d = new Date((sec + 8*3600) * 1000);
      const y = d.getUTCFullYear(), mo = pad(d.getUTCMonth()+1), da = pad(d.getUTCDate());
      const hh = pad(d.getUTCHours()), mm = pad(d.getUTCMinutes()), ss = pad(d.getUTCSeconds());
      return `${y}-${mo}-${da}T${hh}:${mm}:${ss}.000+08:00`;
    } catch { return ""; }
  }
  function findTaipeiIsoFromMap(id){
    let sec = null;
    const normalized = normalizeCommentId(id);
    if (normalized) sec = createdTimeMap.get(normalized);
    if (sec == null) sec = createdTimeMap.get(String(id));
    if (typeof sec === 'number' && sec > 0) {
      return { utc: isoUTCFromEpoch(sec), tpe: isoTaipeiFromEpoch(sec), epoch: sec };
    }
    return { utc:"", tpe:"", epoch:null };
  }
  function extractHoverFullText(anchor){
    if (!anchor) return "";
    const t = anchor.getAttribute('title') || anchor.getAttribute('aria-label') || "";
    return t.trim();
  }

  // 解析台灣中文時間格式 → Unix epoch seconds
  function parseTaiwanDateTime(str) {
    if (!str) return null;
    
    // 格式: "2024年10月22日 下午6:03" 或 "2024年10月22日 上午11:45"
    const match = str.match(/(\d+)年(\d+)月(\d+)日\s+(上午|下午)(\d+):(\d+)/);
    if (!match) return null;
    
    let [_, year, month, day, period, hour, minute] = match;
    hour = parseInt(hour);
    minute = parseInt(minute);
    
    // 12小時制轉24小時制
    if (period === '下午' && hour < 12) hour += 12;
    if (period === '上午' && hour === 12) hour = 0;
    
    // 建立台北時區日期 (UTC+8)
    const taipeiMs = new Date(parseInt(year), parseInt(month)-1, parseInt(day), hour, minute, 0, 0).getTime();
    
    // 轉換為 UTC epoch (減去8小時)
    const utcMs = taipeiMs - (8 * 3600 * 1000);
    return Math.floor(utcMs / 1000);
  }

  // ---------- DOM helpers ----------
  async function scrollToLoadComments() {
    const postDialog = getPostDialog();
    const scrollEl = findScrollContainer(postDialog);
    if (!scrollEl) {
      console.warn('[掃單] scrollToLoadComments: 找不到可捲動容器');
      return;
    }
    scrollEl.setAttribute('tabindex', '-1'); scrollEl.focus();

    let lastScrollHeight = 0, retry = 0, stableTimes = 0, rounds = 0;
    const startTime = Date.now();

    while (retry < MAX_RETRY && stableTimes < 4 && (Date.now() - startTime) < MAX_TIME) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
      await wait(WAIT_TIME);
      const currentScrollHeight = scrollEl.scrollHeight;
      if (currentScrollHeight === lastScrollHeight) { retry++; stableTimes++; }
      else { retry = 0; stableTimes = 0; lastScrollHeight = currentScrollHeight; }
      
      // 每 5 輪重新收集一次時間戳記
      rounds++;
      if (rounds % 5 === 0) {
        harvestCreatedTimesFromRelayStore();
      }
    }
    // 最後再收集一次
    harvestCreatedTimesFromRelayStore();
  }

  async function expandReplies() {
    const panel = getPostDialog();
    if (!panel) return;
    const replyPat = /查看回覆|查看更多回覆|則回覆|View \d+ repl|View more repl/i;
    const buttons = panel.querySelectorAll('[role="button"]') || [];
    let clickedCount = 0;
    buttons.forEach(btn => {
      const text = (btn.textContent || "").trim();
      if (replyPat.test(text)) {
        btn.click();
        clickedCount++;
      }
    });
    
    if (clickedCount > 0) {
      console.log(`  [展開回覆] 點擊了 ${clickedCount} 個回覆按鈕, 等待載入...`);
      await wait(1500);
    }
    
    harvestCreatedTimesFromRelayStore();
    console.log(`  [回覆完成] 已收集 ${createdTimeMap.size} 個時間戳記`);
  }

  async function expandMoreComments() {
    const panel = getPostDialog();
    if (!panel) return;

    let loops = 0;
    let lastCount = createdTimeMap.size;
    let noChangeCount = 0; // 連續沒有新時間戳記的次數
    
    const matcher = /(查看更多留言|顯示更多留言|查看之前的留言|查看先前的留言|查看較舊的留言|載入更多留言|^\d+則留言$|View more comments|View previous comments|Load more comments|View older comments)/;
    
    while (loops < 30) {
      loops++;
      let clicked = false;
      const buttons = panel.querySelectorAll('[role="button"]');
      
      buttons.forEach(btn => {
        const text = (btn.textContent || "").trim();
        if (matcher.test(text)) {
          btn.click();
          clicked = true;
          console.log(`  [展開留言] 點擊按鈕: "${text}"`);
        }
      });
      
      if (!clicked) {
        console.log(`  [展開留言] 找不到更多按鈕,停止展開`);
        break;
      }
      
      // 等待網路請求完成 - 增加到 2.5 秒
      await wait(2500);
      
      // 從 Relay Store 收集時間戳記
      harvestCreatedTimesFromRelayStore();
      
      const currentCount = createdTimeMap.size;
      console.log(`  [展開留言] 第 ${loops} 輪完成, 已收集 ${currentCount} 個時間戳記 ${currentCount > lastCount ? '(+' + (currentCount - lastCount) + ' 🎉)' : '(無新增)'}`);
      
      // 檢查時間戳記是否有增長
      if (currentCount > lastCount) {
        noChangeCount = 0;
        lastCount = currentCount;
      } else {
        noChangeCount++;
        // 如果連續 3 次都沒有新時間戳記,可能已經沒有更多資料了
        if (noChangeCount >= 3) {
          console.log(`  [展開留言] 連續 ${noChangeCount} 輪無新增時間戳記,停止展開`);
          break;
        }
      }
    }
    
    // 最後再等待並收集一次
    console.log(`  [展開留言] 最後等待 2 秒確保所有請求完成...`);
    await wait(2000);
    harvestCreatedTimesFromRelayStore();
    console.log(`  [展開完成] 共展開 ${loops} 輪, 總計 ${createdTimeMap.size} 個時間戳記`);
  }

  // ---------- Extraction ----------
  async function extractComments() {
    let result = { postID: '', list: [] };

    const panel = getPostDialog();

    await expandReplies(); await wait(600);
    await expandReplies(); await wait(600);

    // 提取前最後一次收集時間戳記
    console.log('  [最終收集] 提取留言前再次收集時間戳記...');
    await wait(1000);
    harvestCreatedTimesFromRelayStore();
    console.log(`  [準備就緒] 共收集 ${createdTimeMap.size} 個時間戳記, 開始提取留言...`);

    const articles = panel?.querySelectorAll('[role="article"]') || [];
    articles.forEach(function (el, index) {
      const texts = el.querySelectorAll('div[dir="auto"]');
      const links = el.querySelectorAll('a');

      const textsArray = Array.from(texts).map(text => text.textContent);
      const message = textsArray.join(',');

      let src = '';
      if (links[0]) {
        const img = links[0].querySelectorAll('image');
        if (img.length > 0) src = img[0].getAttribute('xlink:href') || '';
      }

      // 找姓名連結（跳過含 comment_id 的連結 + 純數字文字）
      let nameLink = null;
      for (let i = 1; i < links.length; i++) {
        const h = links[i].href || '', t = links[i].innerText || '';
        if (!h.includes('comment_id') && t && !/^\d/.test(t)) { nameLink = links[i]; break; }
      }
      const name = nameLink?.innerText || '';

      // 抓取留言者 fbUID（從大頭貼連結的 ?id= 或 /user/ 路徑）
      let fbUID = '';
      for (const lk of Array.from(links)) {
        const h = lk.href || '';
        const m1 = h.match(/[?&]id=(\d+)/); if (m1) { fbUID = m1[1]; break; }
        const m2 = h.match(/\/user\/(\d+)/); if (m2) { fbUID = m2[1]; break; }
      }

      const href = links[links.length - 1]?.href || '';
      const relativeTime = links[links.length - 1]?.innerText || '';

      const url = new URL(href, window.location.origin);
      const groupIDMatch = href.match(/\/groups\/(\d+)/);
      const postIDMatch = href.match(/\/posts\/(\d+)/);

      let groupID = '1778688259118655';
      if (groupIDMatch) groupID = groupIDMatch[1];
      const postID = postIDMatch ? postIDMatch[1] : '';

      const commentID = url.searchParams.get('comment_id');
      let id = commentID || '';
      let parentID = '';
      const replyID = url.searchParams.get('reply_comment_id');
      if (replyID) { id = replyID; parentID = commentID || ''; }

      if (!id) {
        const ft = el.getAttribute('data-ft') || '';
        const m = ft.match(/"commentID":"?(\d+)"?/);
        if (m) id = m[1];
      }

      // hover 完整中文時間
      const timeLink = links[links.length - 1] || null;
      const absoluteTextTW = extractHoverFullText(timeLink);

      // 優先用已收集的 created_time 對應
      if (!createdTimeMap.size) harvestCreatedTimesFromRelayStore();
      let { utc: absoluteIsoUTC, tpe: absoluteIsoTaipei, epoch: absoluteEpoch } = findTaipeiIsoFromMap(id);

      // 備案 1: 從 DOM 的 data-utime 屬性抓取 (Facebook 常用)
      if (!absoluteEpoch && timeLink) {
        const utime = timeLink.getAttribute('data-utime');
        if (utime) {
          const parsedEpoch = parseInt(utime, 10);
          if (!isNaN(parsedEpoch) && parsedEpoch > 0) {
            absoluteEpoch = parsedEpoch;
            absoluteIsoUTC = isoUTCFromEpoch(parsedEpoch);
            absoluteIsoTaipei = isoTaipeiFromEpoch(parsedEpoch);
            console.log(`  [DOM-utime] comment ${id} 從 data-utime: ${utime} → ${absoluteIsoTaipei}`);
          }
        }
      }

      // 備案 2: 查找 <time> 標籤的 datetime 屬性
      if (!absoluteEpoch) {
        const timeTag = el.querySelector('time[datetime]');
        if (timeTag) {
          const datetime = timeTag.getAttribute('datetime');
          try {
            const date = new Date(datetime);
            const parsedEpoch = Math.floor(date.getTime() / 1000);
            if (!isNaN(parsedEpoch) && parsedEpoch > 0) {
              absoluteEpoch = parsedEpoch;
              absoluteIsoUTC = isoUTCFromEpoch(parsedEpoch);
              absoluteIsoTaipei = isoTaipeiFromEpoch(parsedEpoch);
              console.log(`  [DOM-time] comment ${id} 從 <time> datetime: ${datetime} → ${absoluteIsoTaipei}`);
            }
          } catch {}
        }
      }

      // 備案 3: 從 hover 文字解析中文時間
      if (!absoluteEpoch && absoluteTextTW) {
        const parsedEpoch = parseTaiwanDateTime(absoluteTextTW);
        if (parsedEpoch) {
          absoluteEpoch = parsedEpoch;
          absoluteIsoUTC = isoUTCFromEpoch(parsedEpoch);
          absoluteIsoTaipei = isoTaipeiFromEpoch(parsedEpoch);
          console.log(`  [DOM解析] comment ${id} 從文字解析時間: ${absoluteTextTW} → ${absoluteIsoTaipei}`);
        }
      }

      if (!absoluteEpoch) {
        console.warn('[PlayBeautyStreet] Missing created_time for comment', id, { relativeTime, absoluteTextTW });
      }

      if (id) {
        result.list.push({
          id, name, message, relativeTime,
          absoluteTextTW, absoluteIsoUTC, absoluteIsoTaipei, absoluteEpoch,
          src, parentID, fbUID
        });
      }

      if (index === articles.length - 1) {
        result.postID = `${groupID}_${postID}`;
      }
    });

    return result;
  }

  // ---------- Orchestrate ----------
  (async function main(){
    try {
      console.log('[PlayBeautyStreet] 開始執行掃單工具...');
      
      // 先掃一輪頁面現成 JSON（立刻建立 createdTimeMap）
      scanAllScriptsForJSON();

      // 滾動/展開，若 FB 又打請求，攔截器會再補充 Map
      console.log('[1/4] 滾動載入留言...');
      await scrollToLoadComments();
      await wait(500);
      
      console.log('[2/4] 展開更多留言...');
      await expandMoreComments(); await wait(500);
      
      console.log('[3/4] 展開回覆...');
      await expandReplies(); await wait(600);

      console.log('[4/4] 提取留言資料...');
      const data = await extractComments();

      const output = JSON.stringify(data, null, 2);
      console.log(`[完成] 共 ${data.list.length} 則留言, ${data.list.filter(c => c.absoluteEpoch).length} 則有時間戳記`);
      
      // 嘗試複製到剪貼簿
      try {
        // 先聚焦到頁面確保有剪貼簿權限
        document.body.focus();
        await navigator.clipboard.writeText(output);
        console.log('[成功] 留言已複製到剪貼簿');
        showToast(`✅ 已複製 ${data.list.length} 則留言`);
      } catch (err) {
        console.error('[失敗] 剪貼簿複製失敗:', err);
        // 使用傳統方法作為備案
        const textarea = document.createElement('textarea');
        textarea.value = output;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
          document.execCommand('copy');
          console.log('[備案成功] 使用 execCommand 複製');
          showToast(`✅ 已複製 ${data.list.length} 則留言`);
        } catch (err2) {
          console.error('[備案失敗] execCommand 也失敗:', err2);
          showToast('❌ 複製失敗,請查看 Console');
        }
        document.body.removeChild(textarea);
      }
    } catch (e) {
      console.error('[錯誤]', e);
      showToast('❌ 發生錯誤,請看 Console');
    }
  })();
})();

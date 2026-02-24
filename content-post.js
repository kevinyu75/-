// ====== 批次掃單 Phase 2：單篇貼文頁面 ======
// 由 content-batch.js Phase 1 導航至此
// 從 sessionStorage 讀取工作狀態 → 展開留言 → 擷取 → 導向下一篇

(function () {
  // 安全檢查：只在 Facebook 頁面執行，避免誤注入其他網站
  if (!location.hostname.endsWith('facebook.com')) return;

  const jobRaw = sessionStorage.getItem('__batchScanJob');
  if (!jobRaw) return; // 非批次掃單流程，離開

  let job;
  try { job = JSON.parse(jobRaw); } catch { sessionStorage.removeItem('__batchScanJob'); return; }

  const { groupName, postIDs, currentIndex, results } = job;
  if (!postIDs || currentIndex >= postIDs.length) return;

  // ── 常數 ──────────────────────────────────────
  const WAIT_TIME = 400;
  const MAX_RETRY = 30;
  const MAX_TIME = 20000;

  const wait = ms => new Promise(r => setTimeout(r, ms));

  // ── UI ────────────────────────────────────────
  function showStatus(msg) {
    let el = document.getElementById('__batchScanStatus');
    if (!el) {
      el = document.createElement('div');
      el.id = '__batchScanStatus';
      el.style.cssText = [
        'position:fixed', 'top:20px', 'right:20px', 'z-index:2147483647',
        'padding:12px 20px', 'background:#1877f2', 'color:#fff',
        'border-radius:8px', 'box-shadow:0 4px 8px rgba(0,0,0,.35)',
        'font-size:14px', 'font-weight:bold', 'max-width:340px',
        'line-height:1.5', 'cursor:pointer'
      ].join(';');
      el.title = '點擊可停止';
      el.onclick = () => {
        sessionStorage.removeItem('__batchScanJob');
        el.style.background = '#e53935';
        el.innerText = '⏹ 已停止';
        setTimeout(() => el.remove(), 2000);
      };
      document.body.appendChild(el);
    }
    el.innerText = msg;
  }

  function removeStatus() {
    document.getElementById('__batchScanStatus')?.remove();
  }

  // ── createdTimeMap（時間戳快取）───────────────
  const createdTimeMap = new Map();

  function normalizeCommentId(raw) {
    if (raw == null) return null;
    let value = typeof raw === 'number' ? String(raw) : raw;
    if (typeof value !== 'string' || !value.trim()) return null;
    const t = value.trim();
    if (/^\d+$/.test(t)) return t;
    const m1 = t.match(/_(\d+)$/);
    if (m1) return m1[1];
    if (t.includes('=')) {
      try { const d = atob(t); const m2 = d.match(/_(\d+)$/); if (m2) return m2[1]; } catch {}
    }
    return null;
  }

  function harvestFromObj(obj) {
    if (!obj || typeof obj !== 'object') return;
    const id = obj.legacy_fbid ?? obj.id;
    const ct = obj.created_time ?? obj.creation_time ?? obj.comment_creation_time;
    if (id != null && ct != null) {
      const norm = normalizeCommentId(id);
      const sec = Number(ct);
      if (norm && !isNaN(sec) && sec > 0) {
        createdTimeMap.set(norm, sec);
        createdTimeMap.set(String(id), sec);
      }
    }
    // comment_action_links 結構
    if (Array.isArray(obj.comment_action_links)) {
      for (const link of obj.comment_action_links) {
        const c = link?.comment;
        if (c && typeof c.created_time === 'number' && c.created_time > 0) {
          let numericId = normalizeCommentId(c.legacy_fbid ?? c.id);
          if (!numericId && c.url) { const m = c.url.match(/comment_id=(\d+)/); if (m) numericId = m[1]; }
          if (numericId) createdTimeMap.set(numericId, c.created_time);
          if (c.id) createdTimeMap.set(String(c.id), c.created_time);
        }
      }
    }
    for (const k in obj) {
      if (obj[k] && typeof obj[k] === 'object') harvestFromObj(obj[k]);
    }
  }

  function harvestRelayStore() {
    try {
      if (typeof require !== 'function') return;
      const env = require('CometRelayEnvironment');
      const uid = require('CurrentUserInitialData')?.ACCOUNT_ID ?? null;
      const relayEnv = env?.multiActorEnvironment?.forActor?.(uid) ?? env;
      const source = relayEnv?.getStore?.()?.getSource?.();
      const ids = source?.getRecordIDs?.();
      if (!ids || typeof source.get !== 'function') return;
      for (const rid of ids) {
        const rec = source.get(rid);
        if (!rec || typeof rec !== 'object') continue;
        const legacy = rec.legacy_fbid ?? rec.id;
        const ct = rec.created_time ?? rec.creation_time ?? rec.comment_creation_time;
        if (legacy == null || ct == null) continue;
        const norm = normalizeCommentId(legacy);
        const sec = Number(ct);
        if (norm && !isNaN(sec) && sec > 0) {
          createdTimeMap.set(norm, sec);
          createdTimeMap.set(String(legacy), sec);
        }
      }
    } catch {}
  }

  // ── fetch / XHR 攔截器 ────────────────────────
  const _origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await _origFetch.apply(this, args);
    (async () => {
      try {
        const clone = res.clone();
        const ct = clone.headers.get('content-type') || '';
        if (ct.includes('json') || ct.includes('javascript')) {
          const text = await clone.text();
          text.split('\n').forEach(p => { try { harvestFromObj(JSON.parse(p)); } catch {} });
          try { harvestFromObj(JSON.parse(text)); } catch {}
          setTimeout(harvestRelayStore, 120);
        }
      } catch {}
    })();
    return res;
  };

  (function patchXHR() {
    const _open = XMLHttpRequest.prototype.open;
    const _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (...args) { this._url = args[1]; return _open.apply(this, args); };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', function () {
        try {
          const ct = this.getResponseHeader('content-type') || '';
          if (ct.includes('json') || ct.includes('javascript')) {
            const text = this.responseText || '';
            text.split('\n').forEach(p => { try { harvestFromObj(JSON.parse(p)); } catch {} });
            try { harvestFromObj(JSON.parse(text)); } catch {}
            setTimeout(harvestRelayStore, 120);
          }
        } catch {}
      });
      return _send.apply(this, args);
    };
  })();

  // ── 找 dialog 捲動容器（遞迴深度遍歷，取 scrollHeight 最大者）──
  function findScrollContainer() {
    const dialog = document.querySelector('[role="dialog"]');
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

  // ── 取得操作根節點（dialog 優先）─────────────
  function getRoot() {
    return document.querySelector('[role="dialog"]') || document;
  }

  // ── 切換排序為「由新到舊」────────────────────
  async function switchToNewestComments() {
    const root = getRoot();
    const sortBtn = Array.from(root.querySelectorAll('div[role="button"]'))
      .find(el => /最相關|Top comments|Most relevant|Relevant/.test(el.innerText || ''));
    if (!sortBtn) { console.warn('[掃單] 找不到排序按鈕，略過'); return; }
    sortBtn.click();
    await wait(WAIT_TIME);
    const newestBtn = Array.from(document.querySelectorAll('div[role="menuitem"]'))
      .find(el => /由新到舊|Newest/.test(el.innerText || ''));
    if (!newestBtn) { console.warn('[掃單] 找不到「由新到舊」，略過'); return; }
    newestBtn.click();
    let retries = 10;
    while (retries-- > 0) {
      await wait(500);
      if (Array.from(document.querySelectorAll('div[role="button"]')).find(el => /由新到舊|Newest/.test(el.innerText || ''))) {
        console.log('[掃單] 已切換為「由新到舊」');
        await wait(800);
        return;
      }
    }
    console.warn('[掃單] 無法確認排序是否切換成功');
  }

  // ── 捲動載入留言（與書籤相同邏輯）─────────────
  async function scrollToLoadComments() {
    const container = findScrollContainer();
    console.log('[掃單] scroll container:', container ? container.tagName + '.' + container.className.slice(0, 50) : 'window');
    if (container) {
      container.setAttribute('tabindex', '-1');
      container.focus();
      container.scrollTop = 0; // 先回頂部
      await wait(600);
    }
    let lastH = 0, retry = 0, stable = 0;
    const startTime = Date.now();
    while (retry < MAX_RETRY && stable < 4 && (Date.now() - startTime) < MAX_TIME) {
      if (container) {
        container.scrollTop = container.scrollHeight;
      } else {
        window.scrollTo(0, document.body.scrollHeight);
      }
      await wait(WAIT_TIME);
      const h = container ? container.scrollHeight : document.body.scrollHeight;
      if (h === lastH) { retry++; stable++; } else { retry = 0; stable = 0; lastH = h; }
      if (retry % 5 === 0) harvestRelayStore();
    }
    harvestRelayStore();
  }

  // ── 展開回覆 ──────────────────────────────────
  async function expandAllReplies() {
    const root = getRoot();
    const replyPat = /查看回覆|查看更多回覆|則回覆|View \d+ repl|View more repl/i;
    const morePat = /查看更多留言|查看更多/;
    let changed = true, rounds = 0;
    const startTime = Date.now();
    while (changed && rounds < 20 && (Date.now() - startTime) < 30000) {
      changed = false; rounds++;
      const buttons = Array.from(root.querySelectorAll('[role="button"]'));
      for (const btn of buttons) {
        const t = btn.innerText || '';
        if (replyPat.test(t) || morePat.test(t)) { btn.click(); changed = true; await wait(300); }
      }
      if (changed) await wait(800);
    }
    harvestRelayStore();
  }

  // ── 時間格式化 ────────────────────────────────
  function isoTaipei(sec) {
    try {
      const d = new Date((sec + 8 * 3600) * 1000);
      const p = n => String(n).padStart(2, '0');
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.000+08:00`;
    } catch { return ''; }
  }

  // ── 擷取留言（優先在 dialog 內）────────────────
  function extractComments(callerPostID) {
    const result = { postID: '', list: [], latestTime: 0 };
    const root = getRoot();
    // 優先在 dialog 內找；若沒有 dialog 則全頁尋找
    const articles = Array.from(root.querySelectorAll('[role="article"]'));
    console.log('[掃單] extractComments root=' + (root === document ? 'document' : 'dialog') + ' articles=' + articles.length);

    articles.forEach((el, index) => {
      const texts = el.querySelectorAll('div[dir="auto"]');
      const links = el.querySelectorAll('a');
      const message = Array.from(texts).map(t => t.textContent).join(',');

      // 大頭貼圖
      let src = '';
      if (links[0]) {
        const img = links[0].querySelectorAll('image');
        if (img.length > 0) src = img[0].getAttribute('xlink:href') || '';
      }

      // 姓名（跳過含 comment_id 的連結）
      let nameLink = null;
      for (let i = 1; i < links.length; i++) {
        const h = links[i].href || '', t = links[i].innerText || '';
        if (!h.includes('comment_id') && t && !/^\d/.test(t)) { nameLink = links[i]; break; }
      }
      const name = nameLink?.innerText || '';

      // fbUID
      let fbUID = '';
      for (const lk of Array.from(links)) {
        const h = lk.href || '';
        const m1 = h.match(/[?&]id=(\d+)/); if (m1) { fbUID = m1[1]; break; }
        const m2 = h.match(/\/user\/(\d+)/); if (m2) { fbUID = m2[1]; break; }
      }

      const timeLink = links[links.length - 1];
      const href = timeLink?.href || '';
      const relativeTime = timeLink?.innerText || '';

      let url;
      try { url = new URL(href, window.location.origin); } catch { url = new URL(window.location.href); }

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

      // 從 createdTimeMap 取時間戳記
      const norm = normalizeCommentId(id);
      let sec = (norm ? createdTimeMap.get(norm) : null) ?? createdTimeMap.get(String(id)) ?? null;

      // 備案：<time datetime> 標籤
      if (!sec) {
        const timeTag = el.querySelector('time[datetime]');
        if (timeTag) {
          try { const e = Math.floor(new Date(timeTag.getAttribute('datetime')).getTime() / 1000); if (e > 0) sec = e; } catch {}
        }
      }

      // created_time 以毫秒輸出，與舊書籤格式一致
      // 後端 new Date(commentCreatedTime).getTime() 需要毫秒；若傳秒則變成 1970 年
      const created_time = sec ? sec * 1000 : 0;
      const absoluteIsoTaipei = sec ? isoTaipei(sec) : '';

      if (created_time > result.latestTime) result.latestTime = created_time;

      if (id) {
        result.list.push({ id, name, message, relativeTime, created_time, absoluteIsoTaipei, src, parentID, fbUID });
      }
      if (index === articles.length - 1) {
        result.postID = groupID + '_' + postID;
      }
    });

    if (callerPostID && (!result.postID || result.postID.endsWith('_'))) {
      result.postID = '1778688259118655_' + callerPostID;
    }
    return result;
  }

  // ── 下載 JSON ─────────────────────────────────
  function downloadJSON(allResults) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = 'group-scan-' + groupName + '-' + ts + '.json';
    const blob = new Blob([JSON.stringify(allResults, null, 2)], { type: 'application/json' });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(blobUrl); }, 2000);
    console.log('[掃單] ✅ 完成！共 ' + allResults.length + ' 篇，下載：' + filename);
  }

  // ── 主流程 ────────────────────────────────────
  (async function main() {
    const expectedPostID = postIDs[currentIndex];
    showStatus('📖 (' + (currentIndex + 1) + '/' + postIDs.length + ') 等待頁面載入...');

    // 等待 dialog 或 article 出現（FB 的群組貼文 URL 常以 dialog overlay 呈現）
    for (let i = 0; i < 40; i++) {
      const root = getRoot();
      if (root !== document || document.querySelector('[role="article"]')) break;
      await wait(500);
    }
    // 確保 dialog 內容完全載入
    await wait(1500);
    console.log('[掃單] root=', getRoot() === document ? 'document' : 'dialog');

    harvestRelayStore();

    // 切換排序為「由新到舊」
    showStatus('📖 (' + (currentIndex + 1) + '/' + postIDs.length + ') 切換排序...');
    await switchToNewestComments();

    // 捲動展開全部留言
    showStatus('📖 (' + (currentIndex + 1) + '/' + postIDs.length + ') 捲動載入留言...');
    await scrollToLoadComments();

    // 展開回覆
    showStatus('📖 (' + (currentIndex + 1) + '/' + postIDs.length + ') 展開回覆...');
    await expandAllReplies();
    await wait(500);
    harvestRelayStore();

    // 擷取留言
    const result = extractComments(expectedPostID);
    console.log('[掃單] postID=' + result.postID + '  留言=' + result.list.length + '筆');

    // 更新 job 結果
    const newResults = [...results];
    if (result.list.length > 0) {
      newResults.push({ postID: result.postID, list: result.list });
    }

    const nextIndex = currentIndex + 1;

    if (nextIndex < postIDs.length) {
      // 導向下一篇
      const nextJob = { groupName, postIDs, currentIndex: nextIndex, results: newResults };
      sessionStorage.setItem('__batchScanJob', JSON.stringify(nextJob));
      showStatus('✅ (' + (currentIndex + 1) + '/' + postIDs.length + ') 完成，導向下一篇...');
      await wait(600);
      location.replace('https://www.facebook.com/groups/' + groupName + '/posts/' + postIDs[nextIndex] + '/');
    } else {
      // 全部掃完，下載 JSON
      sessionStorage.removeItem('__batchScanJob');
      removeStatus();
      if (newResults.length === 0) {
        alert('⚠️ 掃描完成但未找到任何留言');
        return;
      }
      downloadJSON(newResults);
    }
  })();
})();

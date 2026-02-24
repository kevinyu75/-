// ====== 批次掃單：社團動態牆 24 小時留言 ======
// 在社團首頁（/groups/xxx）點擊擴充圖示觸發
// 自動捲動收集 postID → 逐篇開 modal 擷取留言 → 下載 JSON

(() => {
  // 防止重複注入
  if (window.__batchScanRunning) {
    console.log('[批次掃單] 已在執行中，忽略重複觸發');
    return;
  }
  window.__batchScanRunning = true;

  // ── 常數 ──────────────────────────────────────
  const WAIT_TIME = 400;
  const MAX_RETRY = 60;
  const MAX_TIME = 60000;
  const BATCH_SIZE = 20;
  const PROBE_INTERVAL = 20;
  const CUTOFF_MS = Date.now() - 24 * 60 * 60 * 1000;

  // ── Utils ─────────────────────────────────────
  const wait = ms => new Promise(r => setTimeout(r, ms));

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
      el.onclick = () => { window.__batchScanStop = true; el.style.background = '#e53935'; el.innerText = '⏹ 停止中...'; };
      document.body.appendChild(el);
    }
    el.innerText = msg;
  }

  function removeStatus() {
    document.getElementById('__batchScanStatus')?.remove();
    window.__batchScanRunning = false;
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

  // 安裝 fetch / XHR 攔截器（讓捲動時的新請求也能被收集到）
  const _origFetch = window.fetch;
  window.fetch = async function(...args) {
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

  function harvestFromObj(obj) {
    if (!obj || typeof obj !== 'object') return;
    const id = obj.legacy_fbid ?? obj.id;
    const ct = obj.created_time ?? obj.creation_time;
    if (id != null && ct != null) {
      const norm = normalizeCommentId(id);
      const sec = Number(ct);
      if (norm && !isNaN(sec) && sec > 0) {
        createdTimeMap.set(norm, sec);
        createdTimeMap.set(String(id), sec);
      }
    }
    for (const k in obj) {
      if (obj[k] && typeof obj[k] === 'object') harvestFromObj(obj[k]);
    }
  }

  // ── Dialog 精確定位 ───────────────────────────
  // 核心問題：FB 動態牆背景存在 26~29 個 [role="dialog"]
  // 其中一個含有 article 但沒關閉按鈕（動態牆 article 容器）
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

  // 等待特定 postID 的 modal 出現（雙重驗證）
  async function waitForDialog(postID, timeout = 12000) {
    // postID 格式為 "groupID_postID"，FB dialog DOM 裡只會出現 postID 部分
    const searchID = postID.includes('_') ? postID.split('_').pop() : postID;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const d = getPostDialog();
      if (d && d.innerHTML.includes(searchID)) return d;
      await wait(200);
    }
    return null;
  }

  // 等待 modal 關閉
  // ⚠️ 不能用 getPostDialog()（需要關閉按鈕），
  //    因為 FB 在關閉動畫一開始就先移除關閉按鈕，導致提早誤判為「已關閉」
  //    改為直接掃描所有 dialog：只要沒有任何一個包含 postID 即視為關閉
  async function waitForDialogGone(postID, timeout = 8000) {
    // postID 格式為 "groupID_postID"，FB dialog DOM 裡只會出現 postID 部分
    const searchID = postID.includes('_') ? postID.split('_').pop() : postID;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const allDialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
        .filter(d => !d.closest('[role="banner"]'));
      const stillThere = allDialogs.some(d => d.innerHTML.includes(searchID));
      if (!stillThere) return;
      await wait(200);
    }
  }

  // 在 dialog 內找最大可捲動容器
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

  // ── 開 / 關 modal ─────────────────────────────
  const groupName = window.location.pathname.split('/groups/')[1]?.split('/')[0] || '';
  const groupFeedURL = 'https://www.facebook.com/groups/' + groupName + '/';

  function openPostModal(postID) {
    const url = 'https://www.facebook.com/groups/' + groupName + '/posts/' + postID + '/';
    history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }

  async function closeDialog(postID) {
    const d = getPostDialog();
    if (!d) return;
    const btn = Array.from(d.querySelectorAll('[aria-label]'))
      .find(el => /^關閉$|^Close$/.test((el.getAttribute('aria-label') || '').trim()));
    if (btn) {
      btn.click();
    } else {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    }
    await waitForDialogGone(postID);
    await wait(300); // 等 FB 關閉動畫結束再恢復 URL
    // 恢復 URL 至社團首頁（靜默 pushState，不觸發 popstate，避免 FB router 重新渲染）
    if (window.location.href.includes('/posts/')) {
      history.pushState({}, '', groupFeedURL);
      await wait(500);
    }
  }

  // ── 捲動載入留言 ──────────────────────────────
  async function scrollToLoadComments() {
    const dialog = getPostDialog();
    const scrollEl = findScrollContainer(dialog);
    if (!scrollEl) {
      console.warn('[批次掃單] scrollToLoadComments: 找不到可捲動容器');
      return;
    }
    scrollEl.setAttribute('tabindex', '-1');
    scrollEl.focus();
    scrollEl.scrollTop = 0;
    await wait(600);
    let lastH = 0, retry = 0, stable = 0;
    const startTime = Date.now();
    while (retry < MAX_RETRY && stable < 4 && (Date.now() - startTime) < MAX_TIME) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
      await wait(WAIT_TIME);
      const h = scrollEl.scrollHeight;
      if (h === lastH) { retry++; stable++; } else { retry = 0; stable = 0; lastH = h; }
      if (retry % 5 === 0) harvestRelayStore();
    }
    harvestRelayStore();
  }

  // ── 展開回覆 ──────────────────────────────────
  async function expandAllReplies() {
    const replyPat = /查看回覆|查看更多回覆|則回覆|View \d+ repl|View more repl/i;
    const morePat = /查看更多/;
    let changed = true, rounds = 0;
    const startTime = Date.now();
    while (changed && rounds < 20 && (Date.now() - startTime) < 30000) {
      changed = false; rounds++;
      Array.from(document.querySelectorAll('[role="button"]')).forEach(btn => {
        const t = btn.innerText || '';
        if (replyPat.test(t) || morePat.test(t)) { btn.click(); changed = true; }
      });
      if (changed) await wait(1000);
    }
    harvestRelayStore();
  }

  // ── 取最新留言時間（探針用）──────────────────
  async function peekLatestCommentTime() {
    await scrollToLoadComments();
    harvestRelayStore();
    let latest = 0;
    createdTimeMap.forEach(sec => { if (sec * 1000 > latest) latest = sec * 1000; });
    return latest;
  }

  // ── 從 dialog 擷取留言 ────────────────────────
  function isoTaipei(sec) {
    try {
      const d = new Date((sec + 8 * 3600) * 1000);
      const p = n => String(n).padStart(2, '0');
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.000+08:00`;
    } catch { return ''; }
  }

  function extractCommentsFromDialog(callerPostID = '') {
    const result = { postID: '', list: [], latestTime: 0 };
    const dialog = getPostDialog();
    const articles = Array.from(dialog?.querySelectorAll('[role="article"]') || []);

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

      // 姓名
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

      let url; try { url = new URL(href, window.location.origin); } catch { url = new URL(window.location.href); }
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

      // 取時間
      const norm = normalizeCommentId(id);
      let sec = (norm ? createdTimeMap.get(norm) : null) ?? createdTimeMap.get(String(id)) ?? null;

      // 備案：<time> 標籤
      if (!sec) {
        const timeTag = el.querySelector('time[datetime]');
        if (timeTag) {
          try { const e = Math.floor(new Date(timeTag.getAttribute('datetime')).getTime() / 1000); if (e > 0) sec = e; } catch {}
        }
      }

      const created_time = sec || 0;
      const absoluteIsoTaipei = sec ? isoTaipei(sec) : '';

      if (created_time > result.latestTime) result.latestTime = created_time * 1000;

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

  // ════════════════════════════════════════════
  // 主流程
  // ════════════════════════════════════════════
  (async function main() {
    if (!groupName) {
      alert('⚠️ 請在社團首頁（/groups/xxx）執行批次掃單！');
      window.__batchScanRunning = false;
      return;
    }

    const allResults = [];

    // ── Phase 1：捲動 feed 收集 postID ──────────
    showStatus('⬇️ Phase 1：捲動收集文章 ID...');

    const collectedIDs = [];
    const foundSet = new Set();
    let stableCount = 0;
    let nextProbeAt = PROBE_INTERVAL;
    let phase1Done = false;

    for (let i = 0; i < 20; i++) {
      if (document.querySelector('[role="feed"]')) break;
      await wait(400);
    }

    while (collectedIDs.length < BATCH_SIZE && stableCount < 4 && !phase1Done) {
      if (window.__batchScanStop) break;

      let newFound = 0;
      document.querySelectorAll('a[href*="set=pcb."], a[href*="set=gm."]').forEach(a => {
        const m = a.href.match(/set=(?:pcb|gm)\.(\d+)/);
        if (!m || foundSet.has(m[1])) return;
        foundSet.add(m[1]); collectedIDs.push(m[1]); newFound++;
      });
      document.querySelectorAll('a[href*="/posts/"]').forEach(a => {
        const h = a.href || '';
        if (!h.includes('/groups/') || h.includes('comment_id')) return;
        const m = h.match(/\/posts\/(\d+)/);
        if (!m || foundSet.has(m[1])) return;
        foundSet.add(m[1]); collectedIDs.push(m[1]); newFound++;
      });

      if (newFound === 0) stableCount++; else stableCount = 0;

      // 探針：對最後一篇先瞭一眼對話是否能開啟
      if (collectedIDs.length >= nextProbeAt) {
        const probeID = collectedIDs[collectedIDs.length - 1];
        showStatus('🔍 探針第 ' + collectedIDs.length + ' 篇 (' + probeID + ')...');
        openPostModal(probeID);
        const probeDialog = await waitForDialog(probeID, 8000);
        if (probeDialog) {
          await closeDialog(probeID);
        }
        nextProbeAt = collectedIDs.length + PROBE_INTERVAL;
      }

      if (collectedIDs.length >= BATCH_SIZE) break;
      showStatus('⬇️ Phase 1：已收集 ' + collectedIDs.length + ' 篇，捲動載入更多...');
      window.scrollTo(0, document.body.scrollHeight);
      await wait(2200);
    }

    if (collectedIDs.length === 0) {
      alert('⚠️ 找不到任何貼文，請確認在社團討論區頁面');
      removeStatus(); return;
    }

    console.log('[批次掃單] Phase 1 完成，共收集 ' + collectedIDs.length + ' 篇 postID:', collectedIDs);
    showStatus('✅ 收集完成 ' + collectedIDs.length + ' 篇，開始讀取留言...');
    await wait(800);
    window.scrollTo(0, 0);
    await wait(500);

    // ── Phase 2：逐篇開 modal 擷取留言 ──────────
    let shouldStop = false;

    for (let i = 0; i < collectedIDs.length && !shouldStop; i++) {
      if (window.__batchScanStop) break;

      const postID = collectedIDs[i];
      showStatus('📖 Phase 2：(' + (i + 1) + '/' + collectedIDs.length + ') 讀取留言 | 已收集 ' + allResults.length + ' 篇');

      openPostModal(postID);
      const dialog = await waitForDialog(postID, 12000);
      if (!dialog) {
        console.warn('[批次掃單] dialog 未開啟，跳過', postID);
        continue;
      }
      await wait(800);

      await scrollToLoadComments();
      await expandAllReplies();
      await wait(500);
      harvestRelayStore();

      const result = extractCommentsFromDialog(postID);

      if (result.list.length === 0) {
        console.log('[批次掃單] ⏩ 無留言，跳過', postID);
      } else {
        allResults.push({ postID: result.postID, list: result.list });
        const latestTime = result.latestTime;
        console.log('[批次掃單] ✅ postID=' + result.postID + ' 留言=' + result.list.length + '筆 最新=' + new Date(latestTime || 0).toLocaleString());
      }

      await closeDialog(postID);
    }

    removeStatus();

    if (allResults.length === 0) {
      alert('⚠️ 掃描完成但未找到任何留言，請確認貼文有留言內容');
      return;
    }

    // ── 下載 JSON ────────────────────────────────
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = 'group-scan-' + groupName + '-' + ts + '.json';
    // MAIN world 無法用 chrome.runtime，改用 DOM <a> click 觸發下載
    const blob = new Blob([JSON.stringify(allResults, null, 2)], { type: 'application/json' });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(blobUrl); }, 2000);
    console.log('[批次掃單] ✅ 完成！共 ' + allResults.length + ' 篇，已觸發下載：' + filename);
  })();
})();

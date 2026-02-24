# 掃單工具 — 開發經驗文件

> 給後續接手的 AI 助手：本文記錄開發過程中踩過的坑與關鍵決策，節省你摸索的時間。

---

## 目錄
1. [專案概覽](#1-專案概覽)
2. [Facebook 頁面結構特性](#2-facebook-頁面結構特性)
3. [⚠️ world: MAIN 是必要條件](#3-️-world-main-是必要條件)
4. [Relay Store 擷取 created_time](#4-relay-store-擷取-created_time)
5. [Dialog DOM 偵測](#5-dialog-dom-偵測)
6. [postID 格式陷阱](#6-postid-格式陷阱)
7. [捲動與虛擬 DOM 消失](#7-捲動與虛擬-dom-消失)
8. [批次掃單流程設計](#8-批次掃單流程設計)
9. [chrome.runtime 在 MAIN world 的限制](#9-chromeruntime-在-main-world-的限制)
10. [fbUID 比對機制](#10-fbuid-比對機制)
11. [已知限制與待改進](#11-已知限制與待改進)

---

## 1. 專案概覽

### 用途
Chrome Extension，用於擷取 Facebook 社團貼文的留言，輸出 JSON 供後台（`dev.playbeautyshop.com/manage?page=manageComments`）解析訂單。

### 檔案結構
```
manifest.json        ← MV3，需要 scripting / storage 權限
background.js        ← Service Worker，監聽圖示點擊，決定注入哪個 script
content.js           ← 單篇：在已開啟的貼文 modal 中擷取留言
content-batch.js     ← 批次：Phase 1 在動態牆收集 postID，Phase 2 逐篇開啟擷取
```

### 輸出格式（JSON）
```json
[
  {
    "postID": "1778688259118655_4318619751792147",
    "list": [
      {
        "id": "4318619751792147",
        "name": "林珈汶",
        "message": "+1",
        "created_time": 1740134400000,
        "absoluteIsoTaipei": "2026-02-21T21:00:00+08:00",
        "src": "https://profile-pic-url...",
        "parentID": null,
        "fbUID": "123456789"
      }
    ]
  }
]
```

---

## 2. Facebook 頁面結構特性

### 2.1 虛擬 DOM 積極回收
Facebook 使用 React + 虛擬化列表，**捲動過的元素會從 DOM 中移除**。  
這對掃單有直接影響：

- **動態牆**：向下捲動後，先前的貼文節點消失 → 收集 postID 必須在節點消失前記錄。
- **貼文 modal 中的留言**：捲動到底後，再往回捲，**前面的留言節點可能已消失**，無法再讀取。
- **應對策略**：必須邊捲動邊擷取，不能等到底部才統一讀取。

### 2.2 大量 dialog 共存
任何時刻，`document.querySelectorAll('[role="dialog"]')` 可能返回 **26~29 個**節點。  
其中大多數是 FB 內部的 portal/overlay（廣告、通知等），並非貼文 modal。

**辨別貼文 modal 的條件（兩者都要滿足）**：
```javascript
function getPostDialog() {
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
    .filter(d => !d.closest('[role="banner"]'));
  // 必須有 article 且有關閉按鈕
  const full = dialogs.find(d => d.querySelector('[role="article"]') && hasCloseBtn(d));
  if (full) return full;
  return dialogs.find(d => hasCloseBtn(d)) || null;
}

function hasCloseBtn(d) {
  return Array.from(d.querySelectorAll('[aria-label]'))
    .some(el => /^關閉$|^Close$/.test((el.getAttribute('aria-label') || '').trim()));
}
```

### 2.3 滾動容器路徑不固定
貼文 modal 內的可捲動區域 **不固定在某個固定的 children 路徑**，不能直接用 `dialog.children[0].children[2]` 這類寫法。  
**解法**：用 DFS 走訪，找 `scrollHeight > clientHeight + 50` 的最大元素：
```javascript
function findScrollContainer(dialog) {
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
```

---

## 3. ⚠️ world: MAIN 是必要條件

### 問題
Chrome Extension 的 content script 預設在 **Isolated World** 執行。  
Isolated World 有自己的 JS 環境，**無法存取頁面主 JS 的全域物件**（如 `window.require`、FB 的 Relay Store）。

結果：`require('CometRelayEnvironment')` 拋出錯誤，所有 `created_time` 都是 `0`。

### 解法
在 `background.js` 的 `executeScript` 加上 `world: 'MAIN'`：
```javascript
chrome.scripting.executeScript({
  target: { tabId: tab.id },
  files: ['content-batch.js'],
  world: 'MAIN'  // ← 這個缺了整個 Relay Store 就讀不到
});
```

### 注意
`world: 'MAIN'` 需要在 `manifest.json` 的 `scripting` 權限加上 host permissions，  
且需要 Chrome 111+。

---

## 4. Relay Store 擷取 created_time

### 為什麼要從 Relay Store 取時間？
FB 的留言 DOM 只顯示**相對時間**（「3分鐘前」、「昨天下午3:47」），  
這類資料在幾分鐘後就變了，且無法換算成精確 Unix 時間。

### Relay Store 路徑
```javascript
function harvestCreatedTimesFromRelayStore() {
  if (typeof require !== 'function') return; // 必須在 MAIN world
  const CometRelayEnvironment = require('CometRelayEnvironment');
  const CurrentUserInitialData = require('CurrentUserInitialData');
  const actorId = CurrentUserInitialData?.ACCOUNT_ID ?? null;
  const multi = CometRelayEnvironment?.multiActorEnvironment;
  const relayEnv = multi?.forActor?.(actorId) ?? CometRelayEnvironment;
  const store = relayEnv?.getStore?.();
  const source = store?.getSource?.();
  const recordIDs = source?.getRecordIDs?.();
  // 走訪每筆 record，找 created_time / legacy_fbid
  for (const recordId of recordIDs) {
    const record = source.get(recordId);
    const legacy = record.legacy_fbid ?? record.id;
    const createdTime = record.created_time ?? record.creation_time;
    // 儲存到 createdTimeMap: Map<commentID, epochSeconds>
  }
}
```

### created_time 單位
Relay Store 中是 **epoch seconds（秒）**，  
輸出 JSON 時轉為 **epoch milliseconds（毫秒）**：
```javascript
created_time: secValue * 1000
```

---

## 5. Dialog DOM 偵測

### waitForDialog（等待 modal 出現）
點擊貼文後，modal 出現需要時間。偵測邏輯：
```javascript
async function waitForDialog(postID, timeout = 12000) {
  const searchID = postID.includes('_') ? postID.split('_').pop() : postID;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const allDialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const d = allDialogs.find(d => d.innerHTML.includes(searchID) && hasCloseBtn(d));
    if (d) return d;
    await wait(300);
  }
  return null;
}
```

### waitForDialogGone（等待 modal 關閉）
關閉 modal 後，DOM 不會立即清理，需等到對應 dialog 消失：
```javascript
async function waitForDialogGone(postID, timeout = 8000) {
  const searchID = postID.includes('_') ? postID.split('_').pop() : postID;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const allDialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const stillThere = allDialogs.some(d => d.innerHTML.includes(searchID));
    if (!stillThere) return;
    await wait(300);
  }
}
```

---

## 6. postID 格式陷阱

### FB postID 有兩種格式

| 格式 | 範例 | 出現在 |
|------|------|-------|
| 完整格式 | `1778688259118655_4318619751792147` | URL、Relay Store 的 postID |
| 短格式 | `4318619751792147` | **貼文 modal 的 DOM innerHTML** |

### 陷阱
如果用**完整格式**搜尋 `dialog.innerHTML`，**永遠找不到**，`waitForDialog` 會立即超時。  
結果：dialog 還沒出現就被認定失敗，導致頁面閃爍跳轉。

### 解法（所有 DOM 搜尋都必須用短格式）
```javascript
// postID 可能是 "groupID_postShortID" 或直接是 "postShortID"
const searchID = postID.includes('_') ? postID.split('_').pop() : postID;
```

---

## 7. 捲動與虛擬 DOM 消失

### 7.1 貼文 modal 留言捲動

**關鍵問題**：留言 modal 有虛擬化列表。往下捲後，往上捲時**頂部留言的 DOM 已消失**。  
必須**邊捲邊擷取**，已讀的留言節點隨時可能消失。

**已實作的策略**（`content.js`）：
1. 每次捲動前擷取目前可見的留言 → 存入 `Map<id, comment>`
2. 繼續向下捲
3. 以 `id` 作為 key，用 Map 去重

### 7.2 動態牆 postID 收集

動態牆同樣虛擬化，向下捲後頂部貼文節點消失。  
**策略**：使用 `Set<postID>` 去重，每次捲動都重新掃 `document.querySelectorAll()`：
```javascript
// 找 postID 的兩種選擇器
document.querySelectorAll('a[href*="set=pcb."], a[href*="set=gm."]')
document.querySelectorAll('a[href*="/posts/"]')
```

**穩定判斷**：連續 4 次捲動都沒有新增 postID → 視為已到 feed 底部：
```javascript
if (newFound === 0) stableCount++;
else stableCount = 0;
if (stableCount >= 4) break;
```

### 7.3 「更多留言」按鈕

留言不是一次全部載入，需反覆點擊「更多留言」按鈕：
```javascript
// 常見的「更多留言」按鈕文字（中英文都有可能）
const moreSelectors = [
  '[aria-label*="更多留言"]',
  '[aria-label*="View more comments"]',
  'div[role="button"]:not([aria-label])'
];
```
**注意**：按鈕點擊後不會立即出現新留言，需等待 500~1000ms 再重新掃瞄。

---

## 8. 批次掃單流程設計

### 為什麼要跨頁面？

貼文留言只能在**貼文 URL 頁面**或**modal 打開時**才能完整讀取。  
批次掃單需要逐篇切換，每次 `location.replace()` 會刷新頁面，content script 會重新注入。

### 跨頁面狀態保存

使用 `sessionStorage`（關閉瀏覽器後清除，但同 tab 頁面跳轉後保留）：
```javascript
// Phase 1 結束時保存工作清單
sessionStorage.setItem('__batchScanJob', JSON.stringify({
  groupName,
  postIDs: collectedIDs,
  currentIndex: 0,
  results: []
}));

// Phase 2 開始時讀取
const job = JSON.parse(sessionStorage.getItem('__batchScanJob') || 'null');
```

### 流程圖
```
[社團動態牆] → 點擊擴充圖示
       ↓
  content-batch.js (Phase 1)
  捲動 feed，收集 postID × N 篇
       ↓
  存入 sessionStorage
  location.replace → 第 1 篇貼文 URL
       ↓
  content-batch.js (Phase 2) 重新注入
  讀取 sessionStorage，確認是哪一篇
  開啟貼文 modal → 展開留言 → 擷取
  儲存結果到 sessionStorage.results[]
       ↓
  [還有下一篇？]
  是 → location.replace → 下一篇
  否 → 觸發 JSON 下載，清除 sessionStorage
```

### 為什麼不用 background.js 管理狀態？
`background.js` 是 Service Worker，會在非活動後被 Chrome **強制暫停**，  
狀態（變數）不保證持久。跨頁面的工作佇列必須存在 `sessionStorage`。

---

## 9. chrome.runtime 在 MAIN world 的限制

### 問題
`world: 'MAIN'` 的 script **無法使用 `chrome.runtime.sendMessage`**，  
嘗試呼叫會拋出：`TypeError: Cannot read properties of undefined`。

這影響了**下載 JSON 的方式**。原來想用 `sendMessage` 通知 background.js 下載，  
但 MAIN world 中 `chrome.runtime` 是 `undefined`。

### 解法：直接在頁面 DOM 觸發下載
```javascript
const blob = new Blob([JSON.stringify(allResults, null, 2)], { type: 'application/json' });
const blobUrl = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = blobUrl;
a.download = `group-scan-${groupName}-${isoNow}.json`;
document.body.appendChild(a);
a.click();
setTimeout(() => {
  document.body.removeChild(a);
  URL.revokeObjectURL(blobUrl);
}, 2000);
```

---

## 10. fbUID 比對機制

### 什麼是 fbUID？
FB 使用者的數字 ID（如 `100050123456789`），與姓名不同，是唯一的。  
有了 fbUID，後台系統可以精確比對到會員，不受改名影響。

### 擷取方式
從留言者的大頭貼 URL 或個人頁連結中取出：
```javascript
// 從 src URL 擷取
// https://scontent.xx.fbcdn.net/v/xxx?_nc_cat=xxx&uid=100050123456789&...
const uidMatch = src.match(/uid=(\d+)/);
// 從個人頁連結擷取（當 URL 是 /profile.php?id=xxx 時）
const profileMatch = href.match(/profile\.php\?id=(\d+)/);
```

### 後台 Vue 端的比對邏輯（posts.js）

⚠️ **重要陷阱**：`searchUsersByFbUID` 是 async API 呼叫，**不能放在 Vue computed property 內**。

**原因**：computed 每次重新求值都會重新發起大量 HTTP 請求，
而 async callback 修改了 reactive 物件（`comment.isCheck = true`），
觸發 computed 再次執行，形成**無窮迴圈**。

**解法**：另立 `loadUsersForComments(list)` 方法，在 `loadSinglePost` 結束時呼叫一次：
```javascript
loadSinglePost: async function(data) {
  // ... 設定商品、postComments 等 ...
  this.postComments = list;
  this.loadUsersForComments(list); // 呼叫一次，非同步但不阻塞
},
loadUsersForComments: async function(list) {
  for (const comment of list) {
    const users = await this.searchUsersByFbUID(comment.fbUID);
    this.$set(comment, 'users', users);  // 用 $set 確保 Vue 2 響應
    this.$set(comment, 'isCheck', true);
  }
}
```

---

## 11. 已知限制與待改進

### BATCH_SIZE 目前設為 20（測試用）
可在 `content-batch.js` 第 16 行改為 `200`：
```javascript
const BATCH_SIZE = 20; // ← 正式使用改為 200
```

### 留言展開不完整
若貼文有 1000+ 則留言，目前的展開邏輯可能在時間限制內沒有完全展開。  
每篇貼文的處理時間上限大約 30~60 秒。

### 回覆留言的 parentID
巢狀留言（回覆）的 `parentID` 需要從 DOM 結構推斷，  
偶爾因 FB DOM 結構變動而失效（parentID 為 null）。

### FB 介面改版風險
所有依賴 `[role="dialog"]`、`[role="article"]`、`[aria-label="關閉"]` 的選擇器，  
在 FB 改版後可能失效，需定期檢查。

### XHR 攔截備用方案
`content.js` 內保留了 `XMLHttpRequest.prototype.send` 的攔截器，  
作為 Relay Store 無法讀取時的備選方案（API response 中含有 created_time）。  
目前以 Relay Store 為主，XHR 攔截已降為輔助。

---

## 附錄：常見錯誤排查

| 症狀 | 可能原因 | 檢查點 |
|------|----------|--------|
| 所有 `created_time` 都是 `0` | `world: 'MAIN'` 未設定 | `background.js` executeScript 的 `world` 參數 |
| `waitForDialog` 超時、頁面快速跳轉 | 用完整 postID 搜尋 DOM | 確認使用 `postID.split('_').pop()` |
| Phase 2 在第一篇就停止 | 貼文太舊被誤判 | 確認沒有 CUTOFF_MS 時間過濾 |
| 下載無法觸發 | `chrome.runtime` 在 MAIN world 不可用 | 使用 DOM `<a>.click()` + Blob URL |
| fbUID 比對閃現又消失 | async 查詢放在 Vue computed 造成無窮迴圈 | 改成獨立的 `loadUsersForComments` 方法 |
| 留言只有前幾筆 | 留言展開按鈕沒有持續點擊 | 確認展開迴圈的 maxRetry 和等待時間夠長 |

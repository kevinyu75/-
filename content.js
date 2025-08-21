
// 主要功能：點擊 extension 圖示時自動複製留言，顯示 toast
const WAIT_TIME = 300;
const MAX_RETRY = 30;
const MAX_TIME = 10000;
async function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function scrollToLoadComments() {
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(d => !d.closest('[role="banner"]'));
  const dialog = dialogs?.[1]?.children?.[0]?.children?.[0]?.children?.[0]?.children?.[1];
  if (!dialog) return;
  dialog.setAttribute('tabindex', '-1');
  dialog.focus();
  let lastScrollHeight = 0;
  let retry = 0;
  let stableTimes = 0;
  const startTime = Date.now();
  while (retry < MAX_RETRY && stableTimes < 4 && (Date.now() - startTime) < MAX_TIME) {
    dialog.scrollTop = dialog.scrollHeight;
    await wait(WAIT_TIME);
    const currentScrollHeight = dialog.scrollHeight;
    if (currentScrollHeight === lastScrollHeight) {
      retry++; stableTimes++;
    } else {
      retry = 0; stableTimes = 0; lastScrollHeight = currentScrollHeight;
    }
  }
}
async function extractComments() {
  let result = { postID: '', list: [] };
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(d => !d.closest('[role="banner"]'));
  const buttons = dialogs[1]?.querySelectorAll('[role="button"]') || [];
  buttons.forEach(btn => {
    const text = btn.textContent.trim();
    if (/^查看(全部)?\d+則回覆$/.test(text) || text === '查看 1 則回覆') {
      btn.click();
    }
  });
  await wait(600);
  const buttons2 = dialogs[1]?.querySelectorAll('[role="button"]') || [];
  buttons2.forEach(btn => {
    const text = btn.textContent.trim();
    if (/^查看(全部)?\d+則回覆$/.test(text) || text === '查看 1 則回覆') {
      btn.click();
    }
  });
  await wait(600);
  const articles = dialogs[1]?.querySelectorAll('[role="article"]') || [];
  articles.forEach(function (el, index) {
    const texts = el.querySelectorAll('div[dir="auto"]');
    const links = el.querySelectorAll('a');
    const textsArray = Array.from(texts).map(text => text.textContent);
    const message = textsArray.join(',');
    let src = '';
    if (links[0]) {
      const img = links[0].querySelectorAll('image');
      if (img.length > 0) {
        src = img[0].getAttribute('xlink:href') || '';
      }
    }
    const name = links[1]?.innerText || '';
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
    if (id) {
      result.list.push({ id, name, message, relativeTime, src, parentID });
    }
    if (index === articles.length - 1) {
      result.postID = `${groupID}_${postID}`;
    }
  });
  return result;
}

function showToast(msg) {
  let toast = document.createElement('div');
  toast.innerText = msg;
  toast.style.position = 'fixed';
  toast.style.top = '50%';
  toast.style.left = '50%';
  toast.style.transform = 'translate(-50%, -50%)';
  toast.style.background = 'rgba(60,60,60,0.95)';
  toast.style.color = '#fff';
  toast.style.padding = '16px 28px';
  toast.style.borderRadius = '8px';
  toast.style.fontSize = '18px';
  toast.style.fontWeight = 'bold';
  toast.style.zIndex = '99999';
  toast.style.boxShadow = '0 4px 16px rgba(0,0,0,0.25)';
  toast.style.opacity = '0';
  toast.style.transition = 'opacity 0.2s';
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '1'; }, 10);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 1500);
}

(async function(){
  await scrollToLoadComments();
  await wait(500);
  const data = await extractComments();
  const output = JSON.stringify(data, null, 2);
  try {
    await navigator.clipboard.writeText(output);
    showToast('留言已複製');
  } catch {
    showToast('複製失敗，請檢查權限');
  }
})();

// 临时调试工具：iOS 桌面端(standalone) OAuth 上挪问题专用。
// 自动记录每一次视口变化，日志写入 localStorage（OAuth 跳转/刷新后不丢），
// 在屏幕上用中文显示，方便截图。完全不碰 App.jsx 的高度代码，零布局风险。
//
// 开启：在该 PWA 的 Web Inspector 控制台里执行一次
//   localStorage.__vpdebug='1'; location.reload()
// 关闭：点面板上的「关闭」按钮，或控制台执行
//   localStorage.removeItem('__vpdebug'); location.reload()

const LOG_KEY = '__vplog';
const FLAG_KEY = '__vpdebug';
const MAX = 80;

const EVENT_CN = {
  载入: '载入',
  resize: '缩放',
  scroll: '滚动',
  pageshow: '页面显示',
  pagehide: '页面隐藏',
  visibilitychange: '可见性',
  focus: '聚焦',
  blur: '失焦',
  orientationchange: '转向',
  'vv-resize': '视口·缩放',
  'vv-scroll': '视口·滚动',
};

function readLvh() {
  try {
    const p = document.createElement('div');
    p.style.cssText =
      'position:fixed;top:0;left:0;width:0;height:100lvh;visibility:hidden;pointer-events:none';
    document.body.appendChild(p);
    const h = p.getBoundingClientRect().height;
    p.remove();
    return Math.round(h);
  } catch {
    return 0;
  }
}

function loadLog() {
  try {
    return JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveLog(arr) {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(arr.slice(-MAX)));
  } catch {}
}

export function initVpLogger() {
  let on = false;
  try {
    on = localStorage.getItem(FLAG_KEY) === '1';
  } catch {}
  if (!on) return;
  if (window.__vpLoggerStarted) return;
  window.__vpLoggerStarted = true;

  const t0 =
    Number(sessionStorage.getItem('__vpt0')) ||
    (() => {
      const t = Date.now();
      try {
        sessionStorage.setItem('__vpt0', String(t));
      } catch {}
      return t;
    })();

  let log = loadLog();

  const snap = (label) => {
    const vv = window.visualViewport || {};
    const root = document.getElementById('root');
    const entry = {
      ms: Date.now() - t0,
      ev: label,
      iH: window.innerHeight,
      lvh: readLvh(),
      sY: Math.round(window.scrollY || 0),
      dT: Math.round(document.documentElement.scrollTop || 0),
      vT: Math.round(vv.offsetTop || 0),
      vH: Math.round(vv.height || 0),
      rT: root ? Math.round(root.getBoundingClientRect().top) : null,
      rH: root ? root.offsetHeight : null,
      vp: typeof window.__vpH === 'number' ? window.__vpH : null,
    };
    log.push(entry);
    if (log.length > MAX) log = log.slice(-MAX);
    saveLog(log);
    render();
  };

  // ---- UI ----
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:2147483647;max-height:42vh;overflow:auto;' +
    'background:rgba(0,0,0,0.82);color:#7CFC7C;font:10px/1.35 ui-monospace,Menlo,monospace;' +
    'padding:4px 6px;white-space:pre;-webkit-overflow-scrolling:touch';

  const bar = document.createElement('div');
  bar.style.cssText =
    'position:sticky;top:0;background:rgba(0,0,0,0.92);padding:2px 0;margin:-4px -6px 4px;' +
    'display:flex;gap:6px;align-items:center;color:#fff;font-size:11px';

  const mk = (txt) => {
    const b = document.createElement('button');
    b.textContent = txt;
    b.style.cssText =
      'background:#333;color:#fff;border:1px solid #666;border-radius:4px;padding:2px 8px;font-size:11px';
    return b;
  };
  const bClear = mk('清空');
  const bCopy = mk('复制');
  const bClose = mk('关闭');
  const title = document.createElement('span');
  let fixOn = false;
  try {
    fixOn = localStorage.getItem('__vpfix') === '1';
  } catch {}
  title.textContent = `视口日志 ${fixOn ? '[修:开✅]' : '[修:关]'}`;
  title.style.cssText = 'font-weight:700;margin-right:auto';
  bar.append(title, bClear, bCopy, bClose);

  const body = document.createElement('div');
  panel.append(bar, body);
  document.body.appendChild(panel);

  bClear.onclick = () => {
    log = [];
    saveLog(log);
    render();
  };
  bCopy.onclick = async () => {
    const text = log
      .map(
        (e) =>
          `${String(e.ms).padStart(6)}ms ${EVENT_CN[e.ev] || e.ev} 高=${e.iH} lvh=${e.lvh} 卷Y=${e.sY} 文顶=${e.dT} 视顶=${e.vT} 视高=${e.vH} 根顶=${e.rT} 根高=${e.rH} 修=${e.vp}`
      )
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      bCopy.textContent = '已复制';
      setTimeout(() => (bCopy.textContent = '复制'), 1200);
    } catch {
      bCopy.textContent = '失败';
    }
  };
  bClose.onclick = () => {
    try {
      localStorage.removeItem(FLAG_KEY);
    } catch {}
    panel.remove();
    window.__vpLoggerStarted = false;
  };

  function render() {
    // 最新在最上面
    body.textContent = log
      .slice()
      .reverse()
      .map((e) => {
        const cn = EVENT_CN[e.ev] || e.ev;
        return `${String(e.ms).padStart(6)}  ${cn.padEnd(5, '　')} 高${e.iH} lvh${e.lvh} 卷Y${e.sY} 文顶${e.dT} 根顶${e.rT} 修${e.vp}`;
      })
      .join('\n');
  }

  render();
  snap('载入');

  // ---- 监听所有可能引起上挪的事件 ----
  const winEvents = [
    'resize',
    'scroll',
    'pageshow',
    'pagehide',
    'visibilitychange',
    'focus',
    'blur',
    'orientationchange',
  ];
  winEvents.forEach((ev) =>
    window.addEventListener(ev, () => snap(ev), { passive: true, capture: true })
  );
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => snap('vv-resize'), {
      passive: true,
    });
    window.visualViewport.addEventListener('scroll', () => snap('vv-scroll'), {
      passive: true,
    });
  }
}

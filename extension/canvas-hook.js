// ============================================================
//  Remote Browser Bridge — document_start Canvas 文字钩子
//  在 MAIN 世界、所有 frame、页面脚本运行之前 patch fillText/strokeText，
//  赶在 canvas 绘制之前就装好，捕获用 canvas 渲染的正文（如 Boss 在线简历）。
//  被动只读：仅记录绘制的文字（带坐标/字体/canvasId/scrollTop），缓冲区有上限。
//  与 background 的 install_resume_hook 用同一组全局变量，读取函数通用。
// ============================================================
(function () {
  try {
    if (window.__bossResumeCanvasHookInstalled) return;
    var CRC = window.CanvasRenderingContext2D;
    if (!CRC || !CRC.prototype) return;
    window.__bossResumeCanvasHookInstalled = true;
    window.__bossResumeCanvasTexts = window.__bossResumeCanvasTexts || [];
    var CAP = 400000; // 上限，防止 canvas 动画/游戏页无限累积
    var origFill = CRC.prototype.fillText;
    var origStroke = CRC.prototype.strokeText;
    // 视口大小的 canvas 会随滚动重绘：绝对行位置 = 绘制 y + 滚动偏移。
    // 必须在“绘制时”读到真实滚动偏移，否则不同滚动位置的不同内容会拿到相同 y → 撞行/文字交织。
    // 优先级：受控扫描显式设的 __bossResumeScrollTop > canvas 的滚动祖先容器 > 文档 scrollingElement。
    function currentScrollTop(canvas) {
      if (window.__bossResumeScrollTop) return Number(window.__bossResumeScrollTop) || 0;
      try {
        // 找并缓存 canvas 的滚动祖先（遍历一次即可，避免每次绘制都走 DOM 链）
        if (canvas && canvas.__bossScrollParent == null) {
          var p = canvas.parentElement, found = null, guard = 0;
          while (p && guard++ < 40) {
            var oy = '';
            try { oy = getComputedStyle(p).overflowY; } catch (e) {}
            if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && p.scrollHeight > p.clientHeight + 2) { found = p; break; }
            p = p.parentElement;
          }
          if (found) { try { canvas.__bossScrollParent = found; } catch (e) {} }
        }
        var sc = (canvas && canvas.__bossScrollParent) || document.scrollingElement || document.documentElement;
        return (sc && sc.scrollTop) || 0;
      } catch (e) { return 0; }
    }
    function record(kind, ctx, args) {
      try {
        var buf = window.__bossResumeCanvasTexts;
        if (buf.length >= CAP) buf.splice(0, CAP >> 1);
        var canvas = ctx && ctx.canvas;
        buf.push({
          kind: kind,
          text: String(args[0] == null ? '' : args[0]),
          x: Number(args[1] || 0),
          y: Number(args[2] || 0),
          font: String(ctx.font || ''),
          fillStyle: String(ctx.fillStyle || ''),
          strokeStyle: String(ctx.strokeStyle || ''),
          canvasId: (canvas && canvas.id) || '',
          canvasWidth: (canvas && canvas.width) || 0,
          canvasHeight: (canvas && canvas.height) || 0,
          scrollTop: currentScrollTop(canvas),
          at: Date.now(),
        });
      } catch (e) {}
    }
    CRC.prototype.fillText = function () { record('fillText', this, arguments); return origFill.apply(this, arguments); };
    CRC.prototype.strokeText = function () { record('strokeText', this, arguments); return origStroke.apply(this, arguments); };
    window.__bossResumeCanvasHookProbe = function () {
      try { var c = document.createElement('canvas'); c.width = 1; c.height = 1; c.getContext('2d').fillText('Boss-TraceID test', 0, 0); return true; } catch (e) { return false; }
    };
  } catch (e) {}
})();

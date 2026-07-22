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
          scrollTop: Number(window.__bossResumeScrollTop || 0),
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

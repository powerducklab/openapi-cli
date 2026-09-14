/**
 * HTML reporter: self-contained, compact report with a clean minimal aesthetic.
 * No external dependencies — opens in any browser.
 */
import fs from "node:fs";
import path from "node:path";
import type { TestReport, TestResult } from "../types.js";

export function generateHtmlReport(report: TestReport, outputDir: string): string {
  const dir = path.resolve(outputDir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "report.html");
  fs.writeFileSync(filePath, renderHtml(report), "utf-8");
  return filePath;
}

function renderHtml(report: TestReport): string {
  const { summary, results } = report;
  const data = JSON.stringify({ summary, results });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Test Report — Powerduck</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#ffffff;--fg:#0f172a;--muted:#64748b;--border:#e2e8f0;
    --bg-subtle:#f8fafc;--bg-hover:#f1f5f9;
    --green:#16a34a;--green-bg:#f0fdf4;--green-border:#bbf7d0;
    --red:#dc2626;--red-bg:#fef2f2;--red-border:#fecaca;
    --amber:#d97706;--amber-bg:#fffbeb;--amber-border:#fde68a;
    --blue:#2563eb;--mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace;
    --sans:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Inter,sans-serif;
  }
  @media (prefers-color-scheme:dark){
    :root{
      --bg:#0f172a;--fg:#f1f5f9;--muted:#94a3b8;--border:#1e293b;
      --bg-subtle:#1e293b;--bg-hover:#334155;
      --green:#4ade80;--green-bg:rgba(74,222,128,.1);--green-border:rgba(74,222,128,.25);
      --red:#f87171;--red-bg:rgba(248,113,113,.1);--red-border:rgba(248,113,113,.25);
      --amber:#fbbf24;--amber-bg:rgba(251,191,36,.1);--amber-border:rgba(251,191,36,.25);
      --blue:#60a5fa;
    }
  }
  body{font-family:var(--sans);background:var(--bg);color:var(--fg);line-height:1.5;font-size:14px;-webkit-font-smoothing:antialiased}
  .wrap{max-width:960px;margin:0 auto;padding:32px 24px 64px}

  /* Header */
  .hdr{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid var(--border)}
  .hdr h1{font-size:18px;font-weight:600;letter-spacing:-.01em}
  .hdr .meta{font-size:12px;color:var(--muted);font-family:var(--mono)}

  /* Summary strip */
  .strip{display:grid;grid-template-columns:repeat(6,1fr);gap:0;border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:24px}
  .stat{padding:14px 16px;border-right:1px solid var(--border);text-align:center}
  .stat:last-child{border-right:none}
  .stat .v{font-size:22px;font-weight:700;letter-spacing:-.02em;line-height:1.2}
  .stat .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-top:2px}
  .stat.total .v{color:var(--fg)}
  .stat.pass .v{color:var(--green)}
  .stat.fail .v{color:var(--red)}
  .stat.err .v{color:var(--amber)}
  .stat.rate .v{color:var(--blue)}
  .stat.time .v{font-size:16px;font-weight:600}

  /* Progress */
  .bar{height:4px;background:var(--border);border-radius:2px;overflow:hidden;margin-bottom:24px;display:flex}
  .bar>div{height:100%}
  .bar .p{background:var(--green)}
  .bar .f{background:var(--red)}
  .bar .e{background:var(--amber)}

  /* Filters */
  .filters{display:flex;gap:4px;margin-bottom:16px}
  .fbtn{padding:4px 12px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--muted);cursor:pointer;font-size:12px;font-weight:500;transition:all .12s}
  .fbtn:hover{color:var(--fg);background:var(--bg-hover)}
  .fbtn.active{background:var(--bg-subtle);color:var(--fg);border-color:var(--border)}
  .fbtn .n{color:var(--muted);margin-left:4px;font-variant-numeric:tabular-nums}

  /* Test rows */
  .row{border:1px solid var(--border);border-radius:8px;margin-bottom:6px;overflow:hidden;transition:border-color .12s}
  .row:hover{border-color:var(--muted)}
  .row-head{display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;user-select:none}
  .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .dot.pass{background:var(--green)}
  .dot.fail{background:var(--red)}
  .dot.err{background:var(--amber)}
  .method{font-family:var(--mono);font-size:11px;font-weight:600;color:var(--muted);min-width:40px;text-transform:uppercase}
  .path{font-family:var(--mono);font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .proto{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);padding:2px 8px;border:1px solid var(--border);border-radius:4px}
  .dur{font-family:var(--mono);font-size:12px;color:var(--muted);min-width:56px;text-align:right;font-variant-numeric:tabular-nums}
  .chev{color:var(--muted);font-size:10px;transition:transform .15s;flex-shrink:0}
  .row.open .chev{transform:rotate(90deg)}

  /* Row body */
  .row-body{display:none;padding:0 14px 12px 32px;border-top:1px solid var(--border)}
  .row.open .row-body{display:block}
  .sect{margin-top:10px}
  .sect-t{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600;margin-bottom:6px}
  .asrt{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:13px}
  .asrt .ck{width:14px;height:14px;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;flex-shrink:0;color:#fff}
  .asrt.pass .ck{background:var(--green)}
  .asrt.fail .ck{background:var(--red)}
  .asrt .an{color:var(--fg)}
  .asrt .ae{color:var(--red);font-size:12px;margin-left:6px;font-family:var(--mono)}
  .rmeta{display:flex;gap:20px;flex-wrap:wrap;font-size:12px}
  .rmeta span{color:var(--muted)}
  .rmeta strong{color:var(--fg);font-weight:600;font-family:var(--mono)}
  .errbox{background:var(--red-bg);border:1px solid var(--red-border);border-radius:6px;padding:8px 12px;color:var(--red);font-size:12px;font-family:var(--mono);margin-top:10px}
  .bprev{background:var(--bg-subtle);border:1px solid var(--border);border-radius:6px;padding:10px 12px;font-family:var(--mono);font-size:11px;color:var(--muted);max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-all;margin-top:6px}

  footer{margin-top:32px;padding-top:16px;border-top:1px solid var(--border);font-size:11px;color:var(--muted);display:flex;justify-content:space-between}

  @media(max-width:640px){
    .strip{grid-template-columns:repeat(3,1fr)}
    .stat:nth-child(3){border-right:none}
    .stat:nth-child(4),.stat:nth-child(5){border-top:1px solid var(--border)}
    .path{font-size:11px}
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <h1>Test Report</h1>
    <span class="meta">${report.generatedAt} · v${report.version}</span>
  </div>

  <div class="strip">
    <div class="stat total"><div class="v">${summary.total}</div><div class="l">Total</div></div>
    <div class="stat pass"><div class="v">${summary.passed}</div><div class="l">Passed</div></div>
    <div class="stat fail"><div class="v">${summary.failed}</div><div class="l">Failed</div></div>
    <div class="stat err"><div class="v">${summary.errors}</div><div class="l">Errors</div></div>
    <div class="stat rate"><div class="v">${summary.passRate}%</div><div class="l">Pass Rate</div></div>
    <div class="stat time"><div class="v">${(summary.durationMs/1000).toFixed(2)}s</div><div class="l">Duration</div></div>
  </div>

  <div class="bar">
    <div class="p" style="width:${summary.total?summary.passed/summary.total*100:0}%"></div>
    <div class="f" style="width:${summary.total?summary.failed/summary.total*100:0}%"></div>
    <div class="e" style="width:${summary.total?summary.errors/summary.total*100:0}%"></div>
  </div>

  <div class="filters">
    <button class="fbtn active" data-f="all">All<span class="n">${summary.total}</span></button>
    <button class="fbtn" data-f="passed">Passed<span class="n">${summary.passed}</span></button>
    <button class="fbtn" data-f="failed">Failed<span class="n">${summary.failed}</span></button>
    <button class="fbtn" data-f="error">Errors<span class="n">${summary.errors}</span></button>
  </div>

  <div id="list"></div>

  <footer>
    <span>@powerduck/openapi-cli v${report.version}</span>
    <span>${summary.passed}/${summary.total} passed</span>
  </footer>
</div>

<script>
const D=${data};
function esc(s){const d=document.createElement('div');d.textContent=String(s??'');return d.innerHTML}
function render(f){
  const list=document.getElementById('list');
  const items=f==='all'?D.results:D.results.filter(r=>r.status===f);
  list.innerHTML=items.map(r=>{
    const as=r.assertions?r.assertions.map(a=>\`
      <div class="asrt \${a.passed?'pass':'fail'}">
        <div class="ck">\${a.passed?'✓':'✗'}</div>
        <span class="an">\${esc(a.name)}</span>
        \${a.error?'<span class="ae">'+esc(a.error)+'</span>':''}
      </div>\`).join(''):'';
    const bp=r.response?.body?'<div class="bprev">'+esc(JSON.stringify(r.response.body,null,2).slice(0,3000))+'</div>':'';
    const eb=r.error?'<div class="errbox">'+esc(r.error)+'</div>':'';
    const rm=r.response?\`
      <div class="rmeta">
        \${r.response.status!=null?'<span>Status <strong>'+r.response.status+(r.response.statusText?' '+r.response.statusText:'')+'</strong></span>':''}
        \${r.response.contentType?'<span>Type <strong>'+esc(r.response.contentType)+'</strong></span>':''}
        \${r.response.sizeBytes!=null?'<span>Size <strong>'+r.response.sizeBytes+'B</strong></span>':''}
        \${r.response.streaming?'<span>Streaming <strong>yes</strong></span>':''}
      </div>\`:'';
    return \`
      <div class="row \${r.status}" data-s="\${r.status}">
        <div class="row-head" onclick="this.parentElement.classList.toggle('open')">
          <div class="dot \${r.status==='passed'?'pass':r.status==='failed'?'fail':'err'}"></div>
          <span class="method">\${r.method}</span>
          <span class="path">\${esc(r.path)}</span>
          \${r.protocol?'<span class="proto">'+r.protocol+'</span>':''}
          <span class="dur">\${r.durationMs}ms</span>
          <span class="chev">▶</span>
        </div>
        <div class="row-body">
          \${eb}
          \${rm}
          \${as?'<div class="sect"><div class="sect-t">Assertions</div>'+as+'</div>':''}
          \${bp?'<div class="sect"><div class="sect-t">Response</div>'+bp+'</div>':''}
        </div>
      </div>\`;
  }).join('');
}
document.querySelectorAll('.fbtn').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('.fbtn').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');render(b.dataset.f);
}));
render('all');
</script>
</body>
</html>`;
}

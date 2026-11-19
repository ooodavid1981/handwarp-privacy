(() => {
  'use strict';
  const BASE = 'https://wrqjipquwoykblbgsfoy.supabase.co';
  // publishable key：和 App 裡同一把（公開的前端金鑰）。能做什麼由資料庫規則決定：lb_adm_* 只有 lb_admins 名單裡的人能用。
  const KEY = 'sb_publishable_mIiWs4rHpVlopfGvLsQ07A_kv4_2p1U';
  const SKEY = 'hw-admin-session';
  const REASONS = { nickname: '暱稱', cheat: '作弊', other: '其他' };

  const $ = (s) => document.querySelector(s);
  const show = (id) => ['loading', 'login', 'noadmin', 'admin'].forEach(x => $('#' + x).classList.toggle('hidden', x !== id));
  const fmt = (t) => t ? new Date(t).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // ---- 登入世代：每次登入、登出都換一個編號；所有非同步回應在寫回畫面或 session 之前，先確認自己還是同一個世代 ----
  let gen = 0;
  let ctl = new AbortController();   // 這一個世代進行中的請求；登出時整批取消
  class Stale extends Error {}       // 回應回來時已經登出或換人了：靜靜丟掉，不寫回任何東西
  class Expired extends Error {}
  function nextGen() { gen++; ctl.abort(); ctl = new AbortController(); return gen; }
  function same(g) { if (g !== gen) throw new Stale(); }

  // ---- session：只放 sessionStorage（關掉分頁就沒了） ----
  let sess = null;
  function loadSess() { try { sess = JSON.parse(sessionStorage.getItem(SKEY) || 'null'); } catch (e) { sess = null; } }
  function saveSess(s) { sess = s; try { if (s) sessionStorage.setItem(SKEY, JSON.stringify(s)); else sessionStorage.removeItem(SKEY); } catch (e) { /* 存不了就只留在記憶體 */ } }
  function fromToken(j) {
    return { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000, email: (j.user && j.user.email) || '' };
  }

  async function authCall(grant, body, signal) {
    const r = await fetch(`${BASE}/auth/v1/token?grant_type=${grant}`, {
      method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) { const e = new Error('auth failed'); e.status = r.status; throw e; }   // 不帶伺服器的訊息
    return j;
  }
  async function refresh(g) {
    if (!sess || !sess.refresh) return false;
    try {
      const j = await authCall('refresh_token', { refresh_token: sess.refresh }, ctl.signal);
      same(g);
      saveSess(fromToken(Object.assign({ user: { email: sess.email } }, j)));
      return true;
    } catch (e) { if (e instanceof Stale) throw e; if (e && e.name === 'AbortError') throw new Stale(); return false; }
  }

  // 呼叫 RPC：token 快過期先換；401 換一次再試；還是不行就丟 Expired 回登入畫面。
  // 失敗只丟一般錯誤（不把資料庫的 message／hint 顯示給人）。登出（世代改變）時丟 Stale。
  async function rpc(name, args) {
    const g = gen;
    if (!sess) throw new Expired();
    if (Date.now() > sess.exp - 30000 && !(await refresh(g))) throw new Expired();
    for (let i = 0; i < 2; i++) {
      same(g);
      let r;
      try {
        r = await fetch(`${BASE}/rest/v1/rpc/${name}`, {
          method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + sess.access, 'Content-Type': 'application/json' }, body: JSON.stringify(args || {}), signal: ctl.signal,
        });
      } catch (e) { if (e && e.name === 'AbortError') throw new Stale(); throw new Error('network'); }
      same(g);
      if (r.status === 401) { if (i === 0 && await refresh(g)) continue; throw new Expired(); }
      const j = await r.json().catch(() => null);
      same(g);
      if (!r.ok) throw new Error('request failed');
      return j;
    }
    throw new Expired();
  }

  // ---- 確認視窗（所有動作都先確認） ----
  let askDone = null;
  function ask(title, body, withNote) {
    return new Promise(res => {
      const d = $('#confirm'), note = $('#cNote');
      $('#cTitle').textContent = title; $('#cBody').textContent = body;
      note.value = ''; note.classList.toggle('hidden', !withNote);
      const done = (v) => { askDone = null; if (d.open) d.close(); $('#cYes').onclick = $('#cNo').onclick = null; res(v ? { note: note.value.trim() } : null); };
      askDone = done;
      $('#cYes').onclick = () => done(true); $('#cNo').onclick = () => done(false);
      d.oncancel = () => done(false);
      d.showModal();
    });
  }

  function say(box, text, cls) { box.textContent = text; box.className = 'status' + (cls ? ' ' + cls : ''); }
  const GENERIC = '沒有成功，請再試一次。';
  const REASON_TEXT = {
    forbidden: '沒有權限', not_found: '找不到這個玩家', invalid: '格式不對', ambiguous: '對到不只一位玩家，請改用別的方式處理',
    not_masked: '這位玩家目前沒有被遮住', stale: '資料已更新，請重新整理（已自動重新載入）', retry: '系統忙碌，請再試一次', error: '發生錯誤，請再試一次',
  };
  const failText = (r) => '沒有成功：' + (REASON_TEXT[r && r.reason] || '請再試一次');

  // 執行一個管理動作：先確認，再呼叫，再重新讀取
  async function act(title, body, withNote, call, okText) {
    const g = gen;
    const c = await ask(title, body, withNote);
    if (!c || g !== gen) return;
    const box = $('#globalMsg');
    say(box, '處理中…');
    try {
      const r = await call(c.note);
      same(g);
      if (r && r.ok) say(box, okText(r), 'ok'); else say(box, failText(r), 'err');
    } catch (e) {
      if (e instanceof Stale) return;
      if (e instanceof Expired) return toLogin('登入逾時，請重新登入');
      say(box, GENERIC, 'err');
    }
    await loadAll();
  }

  function button(text, cls, fn, disabled) {
    const b = el('button', cls, text); b.type = 'button'; b.disabled = !!disabled; b.onclick = fn; return b;
  }

  function reasonsText(o) {
    return Object.keys(o || {}).map(k => (REASONS[k] || k) + ' ' + o[k]).join('、');
  }

  const restoreBtn = (r, name, disabled) => button('恢復（並忽略檢舉）', '', () => act('恢復「' + name + '」？', '取消隱藏，並把這位玩家目前的檢舉全部標成已處理。', false,
    () => rpc('lb_adm_restore', { p_player: r.player_id }), (x) => '已恢復，忽略 ' + (x.dismissed || 0) + ' 筆檢舉'), disabled);

  function renderReports(rows) {
    const box = $('#reports'); box.replaceChildren();
    if (!rows.length) { box.appendChild(el('div', 'muted', '目前沒有待處理的檢舉。')); return; }
    for (const r of rows) {
      const it = el('div', 'item'), top = el('div', 'top');
      top.appendChild(el('span', 'nick', r.nickname || '（無暱稱）'));
      if (r.masked) top.appendChild(el('span', 'tag mask', r.mask_pending ? '暱稱已遮住（待複查）' : '暱稱已遮住'));
      if (r.hidden) top.appendChild(el('span', 'tag hid', '已隱藏'));
      top.appendChild(el('span', 'muted small', r.pub_id));
      const meta = el('div', 'meta');
      meta.appendChild(el('span', null, '原因：' + reasonsText(r.reasons)));
      meta.appendChild(el('span', null, '檢舉者 ' + r.reporters + ' 人'));
      meta.appendChild(el('span', null, '不同網路 ' + r.ips + ' 個（僅供排序）'));
      meta.appendChild(el('span', null, '共 ' + r.reports + ' 筆'));
      meta.appendChild(el('span', null, fmt(r.first_at) + ' 到 ' + fmt(r.last_at)));
      const name = r.nickname || r.pub_id;
      const btns = el('div', 'btns');
      btns.appendChild(button('隱藏', 'danger', () => act('隱藏「' + name + '」？', '榜上不再出現這位玩家，他的檢舉標成已處理。玩家本人不會被通知。', true,
        (note) => rpc('lb_adm_hide', { p_player: r.player_id, p_note: note || null }), () => '已隱藏')));
      btns.appendChild(restoreBtn(r, name, !r.hidden));
      btns.appendChild(button('忽略', '', () => act('忽略「' + name + '」的檢舉？', '檢舉看過、不處理：標成已處理，不改變隱藏或遮蔽狀態。', false,
        () => rpc('lb_adm_dismiss', { p_player: r.player_id }), (x) => '已忽略 ' + (x.dismissed || 0) + ' 筆檢舉')));
      it.append(top, meta, btns); box.appendChild(it);
    }
  }

  function renderMasked(rows) {
    const box = $('#maskedList'); box.replaceChildren();
    if (!rows.length) { box.appendChild(el('div', 'muted', '目前沒有被遮住暱稱的玩家。')); return; }
    for (const r of rows) {
      const it = el('div', 'item'), top = el('div', 'top');
      top.appendChild(el('span', 'nick', r.nickname || '（無暱稱）'));
      top.appendChild(el('span', 'tag mask', r.reviewed ? '已複查，維持遮蔽' : '待複查'));
      top.appendChild(el('span', 'muted small', r.pub_id));
      const meta = el('div', 'meta');
      meta.appendChild(el('span', null, '遮住於 ' + fmt(r.masked_at)));
      if (r.masked_nick) meta.appendChild(el('span', null, '當時被檢舉的暱稱：' + r.masked_nick + '（僅供參考）'));
      meta.appendChild(el('span', null, '待處理的暱稱檢舉 ' + r.open_reports + ' 筆'));
      if (r.reviewed) meta.appendChild(el('span', null, '複查於 ' + fmt(r.mask_reviewed_at)));
      const name = r.nickname || r.pub_id;
      const btns = el('div', 'btns');
      btns.appendChild(button('維持遮蔽', '', () => act('維持「' + name + '」的遮蔽？', '標成已複查，榜上繼續顯示預設名（Pilot ####），成績照常。遮蔽是針對這位玩家：他改成別的暱稱也一樣遮蔽，要解除請按「解除遮蔽」。', false,
        () => rpc('lb_adm_keep_mask', { p_player: r.player_id, p_masked_at: r.masked_at, p_reviewed_at: r.mask_reviewed_at || null }), () => '已複查，維持遮蔽'), r.reviewed));
      btns.appendChild(button('解除遮蔽', 'danger', () => act('解除「' + name + '」的遮蔽？', '榜上恢復顯示他的暱稱，並把他目前的暱稱檢舉全部標成已處理。', false,
        () => rpc('lb_adm_unmask', { p_player: r.player_id, p_masked_at: r.masked_at, p_reviewed_at: r.mask_reviewed_at || null }), (x) => '已解除遮蔽，忽略 ' + (x.dismissed || 0) + ' 筆暱稱檢舉')));
      it.append(top, meta, btns); box.appendChild(it);
    }
  }

  function renderHidden(rows) {
    const box = $('#hiddenList'); box.replaceChildren();
    if (!rows.length) { box.appendChild(el('div', 'muted', '目前沒有被隱藏的玩家。')); return; }
    for (const r of rows) {
      const it = el('div', 'item'), top = el('div', 'top');
      top.appendChild(el('span', 'nick', r.nickname || '（無暱稱）'));
      top.appendChild(el('span', 'tag hid', '已隱藏'));
      top.appendChild(el('span', 'muted small', r.pub_id));
      const meta = el('div', 'meta');
      meta.appendChild(el('span', null, '隱藏於 ' + fmt(r.hidden_at)));
      meta.appendChild(el('span', null, '待處理檢舉 ' + r.open_reports + ' 筆'));
      if (r.note) meta.appendChild(el('span', null, '備註：' + r.note));
      const name = r.nickname || r.pub_id;
      const btns = el('div', 'btns');
      btns.appendChild(restoreBtn(r, name, false));
      it.append(top, meta, btns); box.appendChild(it);
    }
  }

  // 清空畫面上所有從伺服器讀來的內容（登出、換人時）
  function clearScreen() {
    for (const id of ['reports', 'maskedList', 'hiddenList']) $('#' + id).replaceChildren();
    for (const id of ['sPending', 'sPlayers', 'sMask']) $('#' + id).textContent = '-';
    for (const id of ['reportsMsg', 'globalMsg', 'codeMsg']) say($('#' + id), '');
    $('#code').value = ''; $('#email').value = ''; $('#password').value = '';
    $('#who').textContent = ''; $('#signout').classList.add('hidden');
    if (askDone) askDone(false);
  }

  // 清單請求流水號：只採用最新一次請求的結果（較早發出、較晚回來的回應直接丟棄，不寫回畫面）
  let loadSeq = 0;
  async function loadAll() {
    const g = gen, q = ++loadSeq;
    try {
      const [s, rep, mask, hid] = await Promise.all([rpc('lb_adm_summary'), rpc('lb_adm_reports'), rpc('lb_adm_masked'), rpc('lb_adm_hidden')]);
      same(g);
      if (q !== loadSeq) return false;
      if ([s, rep, mask, hid].some(x => !x || x.ok !== true)) { show('noadmin'); return false; }
      $('#sPending').textContent = s.pending_reports; $('#sPlayers').textContent = s.reported_players; $('#sMask').textContent = s.masks_to_review;
      renderReports(rep.rows || []); renderMasked(mask.rows || []); renderHidden(hid.rows || []);
      say($('#reportsMsg'), '');
      show('admin');
      return true;
    } catch (e) {
      if (e instanceof Stale) return false;
      if (q !== loadSeq) return false;   // 已經有更新的請求，這次的錯誤不用顯示
      if (e instanceof Expired) { toLogin('登入逾時，請重新登入'); return false; }
      show('admin'); say($('#reportsMsg'), '讀不到資料，請再試一次。', 'err'); return false;
    }
  }

  function toLogin(msg) {
    nextGen();   // 取消所有進行中的請求；之後才回來的回應都會被丟掉
    saveSess(null);
    clearScreen();
    say($('#loginMsg'), msg || '', 'err');
    show('login');
  }

  async function start() {
    loadSess();
    if (!sess) return toLogin('');
    $('#who').textContent = sess.email; $('#signout').classList.remove('hidden');
    show('loading');
    await loadAll();
  }

  $('#loginForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const g = nextGen();   // 新的登入世代（也會取消舊的請求）
    const b = $('#loginBtn'); b.disabled = true; say($('#loginMsg'), '登入中…');
    try {
      const j = await authCall('password', { email: $('#email').value.trim(), password: $('#password').value }, ctl.signal);
      same(g);
      saveSess(fromToken(j)); $('#password').value = '';
      say($('#loginMsg'), '');
      $('#who').textContent = sess.email; $('#signout').classList.remove('hidden');
      show('loading'); await loadAll();
    } catch (e) {
      if (!(e instanceof Stale) && !(e && e.name === 'AbortError')) say($('#loginMsg'), e.status === 400 || e.status === 401 ? 'Email 或密碼不對' : '登入失敗，請再試一次。', 'err');
    }
    b.disabled = false;
  };

  $('#signout').onclick = async () => {
    const s = sess;
    toLogin('');
    if (s) { try { await fetch(`${BASE}/auth/v1/logout`, { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + s.access } }); } catch (e) { /* 離線也無妨 */ } }
  };

  $('#codeForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const g = gen;
    const code = $('#code').value.trim().toLowerCase(), msg = $('#codeMsg');
    if (!/^[0-9a-f]{12}$/.test(code)) { say(msg, '刪除代碼是 12 碼（0-9、a-f）', 'err'); return; }
    const c = await ask('用刪除代碼刪除？', '代碼 ' + code + '：刪除對到的玩家與其成績、被拒紀錄、他送出的檢舉。不可復原。', false);
    if (!c || g !== gen) return;
    say(msg, '處理中…');
    try {
      const r = await rpc('lb_adm_purge_by_code', { p_code: code });
      same(g);
      if (r && r.ok) { say(msg, '已刪除：玩家 ' + r.players + '、被拒紀錄 ' + r.rejects + '、檢舉 ' + r.reports, 'ok'); $('#code').value = ''; await loadAll(); }
      else say(msg, failText(r), 'err');
    } catch (e) {
      if (e instanceof Stale) return;
      if (e instanceof Expired) return toLogin('登入逾時，請重新登入');
      say(msg, GENERIC, 'err');
    }
  };

  start();
})();

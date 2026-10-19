/**
 * POSTCARDS PLACE DATABASE — シートからサイトへ反映するスクリプト
 *
 * 使い方は docs/sheet-sync/README.md を見てください。
 * メニュー「POSTCARDS」:
 *   店名だけで全部自動入力     … 下の1〜4を順に実行します（新しい店を足したときは、これだけでOK）
 *   1. 場所情報を自動入力      … 緯度・経度・公式サイト・Googleマップ・営業状況（Google）
 *   2. ジャンル・エリア・価格帯・子供OK・ペットOK … Googleの情報から
 *   3. Instagramを公式サイトから探す
 *   4. タグ・ひとことの下書き  … AIの下書き。黄色い欄は、確認してください
 *   サイトに反映（開発用）/（本番） … シートの内容をSupabaseに送る
 *   接続設定                   … サイトのURLとトークンを保存する（シートには書かない）
 */

var HEADERS = {
  key: 'キー', city: '都市', name: '店名', area: 'エリア', genre: 'ジャンル', tags: 'タグ', note: 'ひとこと',
  price: '価格帯', instagram: 'Instagram', website: '公式サイト', map: 'Googleマップ', lat: '緯度', lng: '経度',
  published: '公開', status: '営業状況', matched: '照合した店名', placeId: 'PlaceID',
  best: 'おすすめの人', when: '時間帯', order: 'おすすめ順', pair: 'あわせて', slot: '枠',
  kids: '子供OK', pets: 'ペットOK'
};
var DRAFT_COLOR = '#fff2cc';   // AIの下書きを入れた欄の色（確認したら色を消してください）
var DRAFT_MAX = 100;           // 下書きは1回に最大この件数

function onOpen() {
  SpreadsheetApp.getUi().createMenu('POSTCARDS')
    .addItem('店名だけで全部自動入力', 'runAll')
    .addSeparator()
    .addItem('1. 場所情報を自動入力（Google）', 'menuLookup')
    .addItem('2. ジャンル・エリア・価格帯などを自動入力', 'menuDetails')
    .addItem('3. Instagramを公式サイトから探す', 'menuInstagram')
    .addItem('4. タグ・ひとことの下書き（AI）', 'menuDraft')
    .addSeparator()
    .addItem('サイトに反映（開発用）', 'syncDev')
    .addItem('サイトに反映（本番）', 'syncProd')
    .addSeparator()
    .addItem('接続設定', 'setup')
    .addToUi();
}

// ---------- 接続設定 ----------
function setup() {
  var ui = SpreadsheetApp.getUi(), p = PropertiesService.getDocumentProperties();
  ['dev', 'prod'].forEach(function (env) {
    var label = env === 'dev' ? '開発用' : '本番';
    var u = ui.prompt('接続設定（' + label + '）', 'サイトのURL（例: https://xxxx.netlify.app ）。空欄のままOKなら変更しません。', ui.ButtonSet.OK_CANCEL);
    if (u.getSelectedButton() !== ui.Button.OK) return;
    if (u.getResponseText().trim()) p.setProperty('URL_' + env, u.getResponseText().trim().replace(/\/+$/, ''));
    var t = ui.prompt('接続設定（' + label + '）', 'トークン（Netlifyの SYNC_TOKEN と同じもの）。空欄のままOKなら変更しません。', ui.ButtonSet.OK_CANCEL);
    if (t.getSelectedButton() !== ui.Button.OK) return;
    if (t.getResponseText().trim()) p.setProperty('TOKEN_' + env, t.getResponseText().trim());
  });
  ui.alert('保存しました。');
}

function conn_(env) {
  var p = PropertiesService.getDocumentProperties();
  var url = p.getProperty('URL_' + env), token = p.getProperty('TOKEN_' + env);
  if (!url || !token) throw new Error('先にメニューの「接続設定」を行ってください。');
  return { url: url + '/.netlify/functions/sync-places', token: token };
}

function req_(c, payload) {
  return { url: c.url, method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + c.token }, payload: JSON.stringify(payload) };
}

function parse_(res) {
  var body = {};
  try { body = JSON.parse(res.getContentText()); } catch (e) {}
  return { code: res.getResponseCode(), body: body };
}

function call_(env, payload) { return parse_(UrlFetchApp.fetch(conn_(env).url, req_(conn_(env), payload))); }

// 複数のリクエストを同時に送る
function callMany_(env, payloads) {
  var c = conn_(env);
  return UrlFetchApp.fetchAll(payloads.map(function (p) { return req_(c, p); })).map(parse_);
}

function env_() { return PropertiesService.getDocumentProperties().getProperty('URL_dev') ? 'dev' : 'prod'; }

// ---------- シートの読み書き ----------
function table_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0], last = sh.getLastRow(), cols = sh.getLastColumn();
  var head = sh.getRange(1, 1, 1, cols).getValues()[0];
  var col = {};
  Object.keys(HEADERS).forEach(function (k) { var i = head.indexOf(HEADERS[k]); if (i >= 0) col[k] = i; });
  ['key', 'city', 'name'].forEach(function (k) {
    if (col[k] === undefined) throw new Error('見出し「' + HEADERS[k] + '」が1行目にありません。');
  });
  var values = last > 1 ? sh.getRange(2, 1, last - 1, cols).getValues() : [];
  var t = { sh: sh, col: col, values: values, cols: cols };
  ensureKeys_(t);
  return t;
}

function ensureKeys_(t) {
  var changed = false;
  t.values.forEach(function (r) {
    if (String(r[t.col.name]).trim() && !String(r[t.col.key]).trim()) { r[t.col.key] = 'n' + Utilities.getUuid().replace(/-/g, '').slice(0, 8); changed = true; }
    if (String(r[t.col.name]).trim() && !String(r[t.col.city]).trim()) { r[t.col.city] = 'Tokyo'; changed = true; }
  });
  if (changed) writeCols_(t, ['key', 'city']);
}

function writeCols_(t, keys) {
  keys.forEach(function (k) {
    if (t.col[k] === undefined || !t.values.length) return;
    t.sh.getRange(2, t.col[k] + 1, t.values.length, 1).setValues(t.values.map(function (r) { return [r[t.col[k]]]; }));
  });
}

function blank_(t, r, k) { return t.col[k] !== undefined && String(r[t.col[k]]).trim() === ''; }
function val_(t, r, k) { return t.col[k] === undefined ? '' : String(r[t.col[k]]).trim(); }
function rowObj_(t, r) { var o = {}; Object.keys(t.col).forEach(function (k) { o[k] = r[t.col[k]]; }); return o; }

function chunks_(arr, n) { var out = []; for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

function need_(t, keys) {
  keys.forEach(function (k) { if (t.col[k] === undefined) throw new Error('見出し「' + HEADERS[k] + '」が1行目にありません。'); });
}

// ---------- 1. 場所情報（Google Places） ----------
function stepLookup_(t, env) {
  need_(t, ['status', 'placeId']);
  var targets = [];
  t.values.forEach(function (r, i) { if (val_(t, r, 'name') && val_(t, r, 'status') === '') targets.push(i); });
  var filled = 0, notFound = 0, errors = 0, firstError = '';
  chunks_(targets, 10).forEach(function (chunk) {
    var rows = chunk.map(function (i) { var r = t.values[i]; return { key: r[t.col.key], name: r[t.col.name], area: t.col.area !== undefined ? r[t.col.area] : '', city: r[t.col.city] }; });
    var res = call_(env, { action: 'enrich', rows: rows });
    if (res.code !== 200) throw new Error('場所情報（' + res.code + '）: ' + JSON.stringify(res.body).slice(0, 300));
    res.body.results.forEach(function (x, j) {
      var r = t.values[chunk[j]];
      if (!x.ok) {
        if (x.status === 'ERROR') { errors++; if (!firstError) firstError = x.error || ''; return; }
        r[t.col.status] = 'NOT_FOUND'; notFound++; return;
      }
      if (blank_(t, r, 'lat') && x.lat != null) r[t.col.lat] = x.lat;
      if (blank_(t, r, 'lng') && x.lng != null) r[t.col.lng] = x.lng;
      if (blank_(t, r, 'website') && x.website) r[t.col.website] = x.website;
      if (t.col.map !== undefined && (val_(t, r, 'map') === '' || val_(t, r, 'map').indexOf('/maps/search/') >= 0) && x.map_url) r[t.col.map] = x.map_url;
      if (t.col.matched !== undefined) r[t.col.matched] = x.matched;
      r[t.col.placeId] = x.place_id;
      r[t.col.status] = x.status || 'OPERATIONAL';
      if (x.status === 'CLOSED_PERMANENTLY' && t.col.published !== undefined) r[t.col.published] = '非公開';
      filled++;
    });
    SpreadsheetApp.getActive().toast('場所情報', '自動入力中', 3);
  });
  writeCols_(t, ['lat', 'lng', 'website', 'map', 'matched', 'placeId', 'status', 'published']);
  return { name: '場所情報', text: '入力 ' + filled + '件 / 見つからない ' + notFound + '件' + (errors ? ' / エラー ' + errors + '件 ' + firstError : '') };
}

// ---------- 2. ジャンル・エリア・価格帯・子供OK・ペットOK ----------
function stepDetails_(t, env) {
  need_(t, ['genre', 'area', 'price', 'placeId']);
  var targets = [];
  t.values.forEach(function (r, i) {
    if (val_(t, r, 'name') && val_(t, r, 'placeId') !== '' && (blank_(t, r, 'genre') || blank_(t, r, 'area') || blank_(t, r, 'price'))) targets.push(i);
  });
  var g = 0, a = 0, p = 0, errors = 0, firstError = '';
  chunks_(targets, 10).forEach(function (chunk) {
    var rows = chunk.map(function (i) { var r = t.values[i]; return { key: r[t.col.key], placeId: r[t.col.placeId] }; });
    var res = call_(env, { action: 'details', rows: rows });
    if (res.code !== 200) throw new Error('ジャンル等（' + res.code + '）: ' + JSON.stringify(res.body).slice(0, 300));
    res.body.results.forEach(function (x, j) {
      var r = t.values[chunk[j]];
      if (!x.ok) { if (x.status === 'ERROR') { errors++; if (!firstError) firstError = x.error || ''; } return; }
      if (blank_(t, r, 'genre') && x.genre) { r[t.col.genre] = x.genre; g++; }
      if (blank_(t, r, 'area') && x.area) { r[t.col.area] = x.area; a++; }
      if (blank_(t, r, 'price') && x.price) { r[t.col.price] = x.price; p++; }
      if (blank_(t, r, 'kids') && x.kids) r[t.col.kids] = x.kids;
      if (blank_(t, r, 'pets') && x.pets) r[t.col.pets] = x.pets;
    });
    SpreadsheetApp.getActive().toast('ジャンル・エリア', '自動入力中', 3);
  });
  writeCols_(t, ['genre', 'area', 'price', 'kids', 'pets']);
  return { name: 'ジャンル・エリア・価格帯', text: 'ジャンル ' + g + ' / エリア ' + a + ' / 価格帯 ' + p + (errors ? ' / エラー ' + errors + '件 ' + firstError : '') };
}

// ---------- 3. Instagram（公式サイトのリンクから） ----------
function stepInstagram_(t, env) {
  need_(t, ['instagram', 'website']);
  var targets = [];
  t.values.forEach(function (r, i) { var ig = val_(t, r, 'instagram');
    if (val_(t, r, 'name') && (ig === '' || ig === '要確認') && val_(t, r, 'website') !== '') targets.push(i); });
  var found = 0, none = 0, errors = 0;
  var groups = chunks_(chunks_(targets, 10), 4);       // 10件ずつ、4つ同時に
  groups.forEach(function (group) {
    var results = callMany_(env, group.map(function (chunk) {
      return { action: 'instagram', rows: chunk.map(function (i) { return { key: t.values[i][t.col.key], website: t.values[i][t.col.website] }; }) };
    }));
    results.forEach(function (res, gi) {
      if (res.code !== 200) { errors += group[gi].length; return; }
      res.body.results.forEach(function (x, j) {
        var r = t.values[group[gi][j]];
        if (x.ok) { r[t.col.instagram] = x.instagram; found++; } else { r[t.col.instagram] = '要確認'; none++; }
      });
    });
    SpreadsheetApp.getActive().toast('Instagram', '自動入力中', 3);
  });
  writeCols_(t, ['instagram']);
  return { name: 'Instagram', text: '見つかった ' + found + '件 / 見つからない ' + none + '件（「要確認」と書きました。手で調べて入れてください）' + (errors ? ' / エラー ' + errors + '件' : '') };
}

// ---------- 4. タグ・ひとこと（AIの下書き） ----------
function stepDraft_(t, env) {
  need_(t, ['genre', 'tags', 'note']);
  var targets = [];
  t.values.forEach(function (r, i) { if (val_(t, r, 'name') && val_(t, r, 'genre') !== '' && (blank_(t, r, 'tags') || blank_(t, r, 'note'))) targets.push(i); });
  var more = targets.length > DRAFT_MAX;
  targets = targets.slice(0, DRAFT_MAX);
  var done = 0, bad = 0, errors = 0, firstError = '';
  var marks = [];
  chunks_(chunks_(targets, 5), 4).forEach(function (group) {   // 5件ずつ、4つ同時に
    var results = callMany_(env, group.map(function (chunk) {
      return { action: 'draft', rows: chunk.map(function (i) { var r = t.values[i]; return { key: r[t.col.key], name: r[t.col.name], genre: r[t.col.genre], area: t.col.area !== undefined ? r[t.col.area] : '', website: t.col.website !== undefined ? r[t.col.website] : '' }; }) };
    }));
    results.forEach(function (res, gi) {
      if (res.code !== 200) { errors += group[gi].length; if (!firstError) firstError = JSON.stringify(res.body).slice(0, 200); return; }
      res.body.results.forEach(function (x, j) {
        var i = group[gi][j], r = t.values[i];
        if (!x.ok) { if (x.status === 'ERROR') { errors++; if (!firstError) firstError = x.error || ''; } else bad++; return; }
        if (blank_(t, r, 'tags') && x.tags && x.tags.length) { r[t.col.tags] = x.tags.join(','); marks.push([i, 'tags']); }
        if (blank_(t, r, 'note') && x.note) { r[t.col.note] = x.note; marks.push([i, 'note']); }
        done++;
      });
    });
    SpreadsheetApp.getActive().toast('タグ・ひとこと', '下書き中', 3);
  });
  writeCols_(t, ['tags', 'note']);
  marks.forEach(function (m) { t.sh.getRange(m[0] + 2, t.col[m[1]] + 1).setBackground(DRAFT_COLOR); });
  return { name: 'タグ・ひとこと（AI下書き）', text: '下書き ' + done + '件（黄色い欄）' + (bad ? ' / 作れなかった ' + bad + '件' : '') + (errors ? ' / エラー ' + errors + '件 ' + firstError : '') + (more ? '\n※まだ残りがあります。もう一度実行してください。' : '') };
}

// ---------- メニュー ----------
function runSteps_(title, steps, confirmText) {
  var ui = SpreadsheetApp.getUi();
  if (ui.alert(title, confirmText, ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  var env = env_(), t = table_(), out = [];
  try {
    steps.forEach(function (f) { out.push(f(t, env)); });
  } catch (e) {
    out.push({ name: '中断', text: e.message });
  }
  ui.alert('完了', out.map(function (o) { return '・' + o.name + ': ' + o.text; }).join('\n') +
    '\n\n「照合した店名」が合っているか、ジャンルが合っているか、黄色い欄（AIの下書き）の内容を、目で確認してください。', ui.ButtonSet.OK);
}

function runAll() {
  runSteps_('店名だけで全部自動入力', [stepLookup_, stepDetails_, stepInstagram_, stepDraft_],
    '空欄だけを埋めます（入力済みの欄は変更しません）。\n場所情報 → ジャンル・エリア・価格帯 → Instagram → タグ・ひとこと（AI下書き）の順に実行します。\n行が多いと数分かかります。続けますか？');
}
function menuLookup() { runSteps_('場所情報', [stepLookup_], '店名から Google で検索して、空欄だけを埋めます。続けますか？'); }
function menuDetails() { runSteps_('ジャンル・エリア・価格帯', [stepDetails_], 'PlaceID のある行について、空欄だけを埋めます。続けますか？'); }
function menuInstagram() { runSteps_('Instagram', [stepInstagram_], '公式サイトから Instagram のリンクを探して、空欄だけを埋めます。続けますか？'); }
function menuDraft() { runSteps_('タグ・ひとこと', [stepDraft_], 'ジャンルのある行について、タグとひとことの下書きを AI で作ります（黄色い欄になります）。続けますか？'); }

// ---------- サイトに反映 ----------
function syncDev() { sync_('dev'); }
function syncProd() { sync_('prod'); }

function sync_(env) {
  var ui = SpreadsheetApp.getUi(), t = table_();
  var rows = t.values.filter(function (r) { return String(r[t.col.name]).trim(); }).map(function (r) { return rowObj_(t, r); });
  var label = env === 'dev' ? '開発用' : '本番';
  if (ui.alert('サイトに反映（' + label + '）', rows.length + '件を ' + label + ' に反映します。\nシートにない場所は、サイトから削除されます。続けますか？', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  var res = call_(env, { action: 'sync', rows: rows });
  if (res.code === 409 && res.body.error === 'too_many_deletions') {
    if (ui.alert('確認', '今のデータ ' + res.body.existing + '件のうち ' + res.body.would_delete + '件が削除されます。\n間違いでなければ OK を押してください。', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
    res = call_(env, { action: 'sync', rows: rows, force: true });
  }
  if (res.code !== 200) { ui.alert('エラー（' + res.code + '）: ' + JSON.stringify(res.body).slice(0, 400)); return; }
  var w = res.body.warnings || [];
  ui.alert('反映しました（' + label + '）', '登録: ' + res.body.upserted + '件 / 削除: ' + res.body.deleted + '件 / サイトに公開: ' + res.body.published + '件' +
    (w.length ? '\n\n確認してください（' + w.length + '件）:\n' + w.slice(0, 10).join('\n') : '') + '\n\nサイトには数分で反映されます。', ui.ButtonSet.OK);
}

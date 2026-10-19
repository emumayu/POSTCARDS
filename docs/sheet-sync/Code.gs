/**
 * POSTCARDS PLACE DATABASE — シートからサイトへ反映するスクリプト
 *
 * 使い方は docs/sheet-sync/README.md を見てください。
 * メニュー「POSTCARDS」に、次の項目を追加します。
 *   1. 足りない情報を自動入力   … 緯度・経度・公式サイト・Googleマップ・営業状況をGoogleから取得してシートに書く
 *   2. サイトに反映（開発用）   … シートの内容を開発用のSupabaseに送る
 *   3. サイトに反映（本番）     … 同じ内容を本番のSupabaseに送る
 *   4. 接続設定                 … サイトのURLとトークンを保存する（シートには書かない）
 */

var HEADERS = {
  key: 'キー', city: '都市', name: '店名', area: 'エリア', genre: 'ジャンル', tags: 'タグ', note: 'ひとこと',
  price: '価格帯', instagram: 'Instagram', website: '公式サイト', map: 'Googleマップ', lat: '緯度', lng: '経度',
  published: '公開', status: '営業状況', matched: '照合した店名', placeId: 'PlaceID',
  best: 'おすすめの人', when: '時間帯', order: 'おすすめ順', pair: 'あわせて', slot: '枠'
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu('POSTCARDS')
    .addItem('足りない情報を自動入力', 'enrichRows')
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

function call_(env, payload) {
  var p = PropertiesService.getDocumentProperties();
  var url = p.getProperty('URL_' + env), token = p.getProperty('TOKEN_' + env);
  if (!url || !token) throw new Error('先にメニューの「接続設定」を行ってください。');
  var res = UrlFetchApp.fetch(url + '/.netlify/functions/sync-places', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token }, payload: JSON.stringify(payload)
  });
  var body = {};
  try { body = JSON.parse(res.getContentText()); } catch (e) {}
  return { code: res.getResponseCode(), body: body };
}

// ---------- シートの読み書き ----------
function sheet_() { return SpreadsheetApp.getActiveSpreadsheet().getSheets()[0]; }

function table_() {
  var sh = sheet_(), last = sh.getLastRow(), cols = sh.getLastColumn();
  var head = sh.getRange(1, 1, 1, cols).getValues()[0];
  var col = {};
  Object.keys(HEADERS).forEach(function (k) { var i = head.indexOf(HEADERS[k]); if (i >= 0) col[k] = i; });
  ['key', 'city', 'name'].forEach(function (k) {
    if (col[k] === undefined) throw new Error('見出し「' + HEADERS[k] + '」が1行目にありません。');
  });
  var values = last > 1 ? sh.getRange(2, 1, last - 1, cols).getValues() : [];
  return { sh: sh, col: col, values: values, cols: cols };
}

function ensureKeys_(t) {
  var changed = false;
  t.values.forEach(function (r) {
    if (String(r[t.col.name]).trim() && !String(r[t.col.key]).trim()) { r[t.col.key] = 'n' + Utilities.getUuid().replace(/-/g, '').slice(0, 8); changed = true; }
    if (String(r[t.col.name]).trim() && !String(r[t.col.city]).trim()) { r[t.col.city] = 'Tokyo'; changed = true; }
  });
  if (changed) {
    t.sh.getRange(2, t.col.key + 1, t.values.length, 1).setValues(t.values.map(function (r) { return [r[t.col.key]]; }));
    t.sh.getRange(2, t.col.city + 1, t.values.length, 1).setValues(t.values.map(function (r) { return [r[t.col.city]]; }));
  }
}

function rowObj_(t, r) {
  var o = {};
  Object.keys(t.col).forEach(function (k) { o[k] = r[t.col[k]]; });
  return o;
}

// ---------- 1. 自動入力 ----------
function enrichRows() {
  var ui = SpreadsheetApp.getUi(), t = table_();
  ensureKeys_(t);
  var targets = [];
  t.values.forEach(function (r, i) {
    var name = String(r[t.col.name]).trim();
    if (!name) return;
    var done = String(r[t.col.status]).trim() !== '';          // 営業状況が入っている行は検索済み
    if (!done) targets.push(i);
  });
  if (!targets.length) { ui.alert('自動入力が必要な行はありません。\n（営業状況が空の行だけを検索します）'); return; }
  if (ui.alert('自動入力', targets.length + '件を Google で検索します。続けますか？\n空の欄だけを埋め、入力済みの欄は変更しません。', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;

  var env = PropertiesService.getDocumentProperties().getProperty('URL_dev') ? 'dev' : 'prod';
  var filled = 0, notFound = 0, errors = 0, firstError = '';
  for (var s = 0; s < targets.length; s += 10) {
    var chunk = targets.slice(s, s + 10);
    var rows = chunk.map(function (i) { var r = t.values[i]; return { key: r[t.col.key], name: r[t.col.name], area: t.col.area !== undefined ? r[t.col.area] : '', city: r[t.col.city] }; });
    var res = call_(env, { action: 'enrich', rows: rows });
    if (res.code !== 200) { ui.alert('エラー（' + res.code + '）: ' + JSON.stringify(res.body).slice(0, 300)); break; }
    res.body.results.forEach(function (x, j) {
      var r = t.values[chunk[j]];
      if (!x.ok) {
        if (x.status === 'ERROR') { errors++; if (!firstError) firstError = x.error || ''; return; }   // 通信エラーなどは次回やり直せるよう空のまま
        r[t.col.status] = 'NOT_FOUND'; notFound++; return;
      }
      var empty = function (k) { return t.col[k] !== undefined && String(r[t.col[k]]).trim() === ''; };
      if (empty('lat') && x.lat != null) r[t.col.lat] = x.lat;
      if (empty('lng') && x.lng != null) r[t.col.lng] = x.lng;
      if (empty('website') && x.website) r[t.col.website] = x.website;
      if (t.col.map !== undefined && (String(r[t.col.map]).trim() === '' || String(r[t.col.map]).indexOf('/maps/search/') >= 0) && x.map_url) r[t.col.map] = x.map_url;
      if (t.col.matched !== undefined) r[t.col.matched] = x.matched;
      if (t.col.placeId !== undefined) r[t.col.placeId] = x.place_id;
      r[t.col.status] = x.status || 'OPERATIONAL';
      if (x.status === 'CLOSED_PERMANENTLY' && t.col.published !== undefined) r[t.col.published] = '非公開';
      filled++;
    });
    SpreadsheetApp.getActive().toast((s + chunk.length) + ' / ' + targets.length, '自動入力中', 5);
  }
  // 書き戻し
  ['lat', 'lng', 'website', 'map', 'matched', 'placeId', 'status', 'published'].forEach(function (k) {
    if (t.col[k] === undefined) return;
    t.sh.getRange(2, t.col[k] + 1, t.values.length, 1).setValues(t.values.map(function (r) { return [r[t.col[k]]]; }));
  });
  ui.alert('完了', '入力できた: ' + filled + '件 / 見つからなかった: ' + notFound + '件（営業状況に NOT_FOUND と書きました）' + (errors ? ' / エラー: ' + errors + '件（もう一度実行してください）\n' + firstError : '') +
    '\n\n「照合した店名」が合っているか、目で確認してください。違う店のときは、緯度・経度・公式サイト・Googleマップの欄を直して、営業状況を空にせず残してください。', ui.ButtonSet.OK);
}

// ---------- 2/3. サイトに反映 ----------
function syncDev() { sync_('dev'); }
function syncProd() { sync_('prod'); }

function sync_(env) {
  var ui = SpreadsheetApp.getUi(), t = table_();
  ensureKeys_(t);
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

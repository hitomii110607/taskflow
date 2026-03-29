/**
 * TaskFlow - メインアプリケーションロジック
 * - タスク管理（CRUD）
 * - LocalStorage 永続化
 * - Service Worker 通知
 * - フィルタリング・検索
 */

'use strict';

// ===================================================
//  定数・初期設定
// ===================================================

const STORAGE_KEY = 'taskflow_tasks';
const SETTINGS_KEY = 'taskflow_settings';
const CATEGORIES_KEY = 'taskflow_categories';

const DEFAULT_CATEGORIES = [
  { id: 'work',    name: '仕事',         color: '#3b82f6' },
  { id: 'private', name: 'プライベート',  color: '#ec4899' },
  { id: 'study',   name: '勉強',         color: '#10b981' },
  { id: 'health',  name: '健康',         color: '#f97316' },
  { id: 'school',  name: '学校',         color: '#8b5cf6' },
  { id: 'nursery', name: '保育園',       color: '#f59e0b' },
  { id: 'other',   name: 'その他',       color: '#94a3b8' },
];

const CATEGORY_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#84cc16', '#22c55e', '#10b981', '#14b8a6',
  '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6',
  '#a855f7', '#d946ef', '#ec4899', '#f43f5e',
  '#94a3b8', '#64748b',
];

const PRIORITY_LABELS = { high: '高', medium: '中', low: '低' };
const REPEAT_LABELS   = { none: 'なし', daily: '毎日', weekly: '毎週', monthly: '毎月', custom: 'カスタム' };
const DAY_NAMES       = ['日', '月', '火', '水', '木', '金', '土'];

// ===================================================
//  State
// ===================================================
let tasks      = [];
let categories = [];
let settings   = {};
let currentFilter    = 'quick';
let editingTaskId    = null;
let selectedPriority = 'medium';
let selectedCategory = '';
let selectedRepeat       = 'none';
let selectedCustomRepeat = { type: 'weekday', weekdays: [], interval: 1, unit: 'day' };
let selectedEstimate     = 'none';
let selectedColor    = CATEGORY_COLORS[9];
let swRegistration   = null;

// ===================================================
//  LocalStorage Helpers
// ===================================================
const load = (key, def) => {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; }
  catch { return def; }
};
const save = (key, val) => {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
};

// ===================================================
//  Init
// ===================================================
document.addEventListener('DOMContentLoaded', () => {
  const isFirstVisit = load(STORAGE_KEY, null) === null;
  loadData();
  initUI();
  registerServiceWorker();
  initTheme();
  if (isFirstVisit) addSampleTasksIfEmpty();
  renderAll();
  checkNotificationBanner();
  setupNotificationListener();
  updateHeaderDate();
  setInterval(updateHeaderDate, 60000);
  // 1分おきに通知チェック（タスク変化対応）
  setInterval(checkScheduledNotifications, 60000);
});

function loadData() {
  tasks    = load(STORAGE_KEY, []);
  settings = load(SETTINGS_KEY, { darkMode: true, notificationsEnabled: false, morningTime: '09:00', eveningTime: '17:00' });
  if (!settings.morningTime) settings.morningTime = '09:00';
  if (!settings.eveningTime) settings.eveningTime = '17:00';

  // カテゴリ：保存済みデータにデフォルトカテゴリをマージ（新規追加分を反映）
  const saved = load(CATEGORIES_KEY, []);
  const merged = [...DEFAULT_CATEGORIES];
  saved.forEach(cat => {
    if (!merged.find(c => c.id === cat.id)) merged.push(cat);
  });
  categories = merged;
  save(CATEGORIES_KEY, categories);
}

function saveData() {
  save(STORAGE_KEY, tasks);
}

function saveSettings() {
  save(SETTINGS_KEY, settings);
}

function saveCategories() {
  save(CATEGORIES_KEY, categories);
}

// ===================================================
//  Service Worker 登録
// ===================================================
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    swRegistration = await navigator.serviceWorker.register('./sw.js');
    console.log('[TaskFlow] SW registered:', swRegistration.scope);
    // SW に通知スケジュール開始を伝える
    const sw = swRegistration.active || swRegistration.installing || swRegistration.waiting;
    if (sw) {
      sw.postMessage({ type: 'SCHEDULE_NOTIFICATIONS' });
    }
  } catch (e) {
    console.warn('[TaskFlow] SW registration failed:', e);
  }
}

// Service Worker からのメッセージを受信してタスクデータを返す
function setupNotificationListener() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', event => {
    const { type } = event.data || {};
    if (type === 'REQUEST_MORNING_DATA') {
      sendMorningNotification();
    } else if (type === 'REQUEST_EVENING_DATA') {
      sendEveningNotification();
    }
  });
}

// ===================================================
//  通知
// ===================================================
function checkNotificationBanner() {
  const banner = document.getElementById('notifBanner');
  if (!('Notification' in window)) {
    banner.style.display = 'none';
    return;
  }
  if (Notification.permission === 'granted') {
    banner.style.display = 'none';
    settings.notificationsEnabled = true;
    saveSettings();
    updateNotifSettingsUI();
  } else if (Notification.permission === 'denied') {
    banner.style.display = 'none';
    updateNotifSettingsUI();
  } else {
    banner.style.display = 'flex';
  }
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    showToast('このブラウザは通知に対応していません', 'error');
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    settings.notificationsEnabled = true;
    saveSettings();
    document.getElementById('notifBanner').style.display = 'none';
    updateNotifSettingsUI();
    // SW にスケジュール開始を伝える
    if (swRegistration) {
      const sw = swRegistration.active;
      if (sw) sw.postMessage({ type: 'SCHEDULE_NOTIFICATIONS' });
    }
    showToast('🔔 通知が有効になりました！', 'success');
  } else {
    showToast('通知が拒否されました。ブラウザ設定から変更できます', 'warning');
  }
}

function updateNotifSettingsUI() {
  const desc   = document.getElementById('notifStatusDesc');
  const toggle = document.getElementById('notifToggle');
  if (!('Notification' in window)) {
    desc.textContent   = '非対応ブラウザです';
    toggle.disabled    = true;
    return;
  }
  const p = Notification.permission;
  if (p === 'granted') {
    desc.textContent  = '✅ 通知が許可されています';
    toggle.checked    = true;
  } else if (p === 'denied') {
    desc.textContent  = '❌ 通知が拒否されています（ブラウザ設定から変更）';
    toggle.checked    = false;
    toggle.disabled   = true;
  } else {
    desc.textContent  = '⚠️ 通知の許可が必要です';
    toggle.checked    = false;
  }
}

// 通知スケジュールチェック（毎分実行）
function checkScheduledNotifications() {
  if (!settings.notificationsEnabled) return;
  if (Notification.permission !== 'granted') return;

  const now  = new Date();
  const h    = now.getHours();
  const m    = now.getMinutes();
  const pad  = n => String(n).padStart(2, '0');
  const nowTime = `${pad(h)}:${pad(m)}`;

  if (nowTime === (settings.morningTime || '09:00')) sendMorningNotification();
  if (nowTime === (settings.eveningTime || '17:00')) sendEveningNotification();
}

function sendMorningNotification() {
  const today        = getDateString(new Date());
  const todayTasks   = tasks.filter(t => !t.completed && t.deadline && getDateString(new Date(t.deadline)) === today);
  const overdueTasks = tasks.filter(t => !t.completed && t.deadline && new Date(t.deadline) < new Date() && getDateString(new Date(t.deadline)) !== today);

  if (swRegistration && swRegistration.active) {
    swRegistration.active.postMessage({
      type: 'SEND_MORNING_NOTIFICATION',
      payload: { todayTasks, overdueTasks }
    });
  } else {
    // Fallback: direct notification
    const total = todayTasks.length + overdueTasks.length;
    const body  = total > 0
      ? `今日のタスク: ${todayTasks.length}件 / 期限切れ: ${overdueTasks.length}件`
      : '今日の予定タスクはありません 🎉';
    new Notification('🌅 おはようございます！', { body, icon: 'icons/icon-192.svg' });
  }
}

function sendEveningNotification() {
  const today         = getDateString(new Date());
  const completedToday = tasks.filter(t => t.completed && t.completedAt && getDateString(new Date(t.completedAt)) === today).length;
  const remainingTasks = tasks.filter(t => !t.completed && t.deadline && new Date(t.deadline) <= new Date(new Date().setHours(23, 59, 59)));

  if (swRegistration && swRegistration.active) {
    swRegistration.active.postMessage({
      type: 'SEND_EVENING_NOTIFICATION',
      payload: { completedToday, remainingTasks }
    });
  } else {
    const body = `完了: ${completedToday}件 / 残り: ${remainingTasks.length}件`;
    new Notification('🌇 お疲れ様でした！', { body, icon: 'icons/icon-192.svg' });
  }
}

function sendTestNotification() {
  if (Notification.permission !== 'granted') {
    showToast('通知の許可が必要です', 'warning');
    return;
  }
  if (swRegistration && swRegistration.active) {
    swRegistration.active.postMessage({ type: 'TEST_NOTIFICATION' });
  } else {
    new Notification('🔔 通知テスト', { body: 'TaskFlowの通知が正常に動作しています！', icon: 'icons/icon-192.svg' });
  }
  showToast('テスト通知を送信しました', 'success');
}

// ===================================================
//  テーマ
// ===================================================
function initTheme() {
  const isDark = settings.darkMode !== false;
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
  document.getElementById('themeBtn').textContent = isDark ? '🌙' : '☀️';
  const toggle = document.getElementById('darkModeToggle');
  if (toggle) toggle.checked = isDark;
  // 通知時刻を設定画面に反映
  const mt = document.getElementById('morningTimeInput');
  const et = document.getElementById('eveningTimeInput');
  if (mt) mt.value = settings.morningTime || '09:00';
  if (et) et.value = settings.eveningTime || '17:00';
}

function toggleTheme() {
  const isDark = document.documentElement.dataset.theme === 'dark';
  const newTheme = isDark ? 'light' : 'dark';
  document.documentElement.dataset.theme = newTheme;
  document.getElementById('themeBtn').textContent = newTheme === 'dark' ? '🌙' : '☀️';
  settings.darkMode = newTheme === 'dark';
  saveSettings();
  const toggle = document.getElementById('darkModeToggle');
  if (toggle) toggle.checked = settings.darkMode;
}

// ===================================================
//  UI 初期化
// ===================================================
function initUI() {
  // ナビゲーション
  document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
    btn.addEventListener('click', () => switchPage(btn.dataset.page));
  });
  document.getElementById('addTaskNavBtn').addEventListener('click', () => openTaskModal());

  // フィルタータブ
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.dataset.filter;
      renderTaskList();
    });
  });

  // ヘッダーボタン
  document.getElementById('themeBtn').addEventListener('click', toggleTheme);
  document.getElementById('searchBtn').addEventListener('click', openSearchModal);

  // 通知バナー
  document.getElementById('enableNotifBtn').addEventListener('click', requestNotificationPermission);

  // タスクモーダル
  document.getElementById('modalClose').addEventListener('click', closeTaskModal);
  document.getElementById('cancelTaskBtn').addEventListener('click', closeTaskModal);
  document.getElementById('saveTaskBtn').addEventListener('click', saveTask);
  document.getElementById('taskModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeTaskModal();
  });

  // 見積もり時間チップ
  document.getElementById('estimateChips').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    document.querySelectorAll('#estimateChips .chip').forEach(c => c.classList.remove('selected'));
    chip.classList.add('selected');
    selectedEstimate = chip.dataset.value;
    applyEstimateToDeadline(selectedEstimate);
  });

  // 優先度チップ
  document.getElementById('priorityChips').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    document.querySelectorAll('#priorityChips .chip').forEach(c => c.classList.remove('selected'));
    chip.classList.add('selected');
    selectedPriority = chip.dataset.value;
  });

  // 繰り返しチップ
  document.getElementById('repeatChips').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    document.querySelectorAll('#repeatChips .chip').forEach(c => c.classList.remove('selected'));
    chip.classList.add('selected');
    selectedRepeat = chip.dataset.value;
    document.getElementById('customRepeatPanel').style.display = selectedRepeat === 'custom' ? 'block' : 'none';
  });

  // カスタム繰り返しパネル
  document.getElementById('customRepeatPanel').addEventListener('click', e => {
    // タイプ切り替え（曜日指定 / 間隔指定）
    const ctypeBtn = e.target.closest('[data-ctype]');
    if (ctypeBtn) {
      document.querySelectorAll('#customRepeatPanel [data-ctype]').forEach(b => b.classList.remove('selected'));
      ctypeBtn.classList.add('selected');
      selectedCustomRepeat.type = ctypeBtn.dataset.ctype;
      document.getElementById('weekdayPanel').style.display  = selectedCustomRepeat.type === 'weekday'  ? 'block' : 'none';
      document.getElementById('intervalPanel').style.display = selectedCustomRepeat.type === 'interval' ? 'block' : 'none';
      return;
    }
    // 曜日ボタン
    const dayBtn = e.target.closest('[data-day]');
    if (dayBtn) {
      const day = parseInt(dayBtn.dataset.day);
      if (selectedCustomRepeat.weekdays.includes(day)) {
        selectedCustomRepeat.weekdays = selectedCustomRepeat.weekdays.filter(d => d !== day);
        dayBtn.classList.remove('selected');
      } else {
        selectedCustomRepeat.weekdays.push(day);
        dayBtn.classList.add('selected');
      }
    }
  });
  document.getElementById('intervalValue').addEventListener('input', e => {
    selectedCustomRepeat.interval = parseInt(e.target.value) || 1;
  });
  document.getElementById('intervalUnit').addEventListener('change', e => {
    selectedCustomRepeat.unit = e.target.value;
  });

  // カテゴリは renderCategorySelect() で動的生成（openTaskModal 時）

  // 設定ページ
  document.getElementById('testNotifRow').addEventListener('click', sendTestNotification);
  document.getElementById('notifToggle').addEventListener('change', async e => {
    if (e.target.checked) await requestNotificationPermission();
    else {
      settings.notificationsEnabled = false;
      saveSettings();
    }
  });
  document.getElementById('darkModeToggle').addEventListener('change', toggleTheme);
  document.getElementById('manageCategoriesRow').addEventListener('click', openCategoryModal);
  document.getElementById('exportRow').addEventListener('click', exportData);
  document.getElementById('exportCsvRow').addEventListener('click', exportCSV);
  document.getElementById('importRow').addEventListener('click', () => document.getElementById('importFileInput').click());
  // 通知時刻変更
  document.getElementById('morningTimeInput').addEventListener('change', e => {
    settings.morningTime = e.target.value;
    saveSettings();
    showToast('🌅 朝の通知時刻を変更しました', 'success');
  });
  document.getElementById('eveningTimeInput').addEventListener('change', e => {
    settings.eveningTime = e.target.value;
    saveSettings();
    showToast('🌇 夕方の通知時刻を変更しました', 'success');
  });
  document.getElementById('importFileInput').addEventListener('change', importData);
  document.getElementById('clearDataRow').addEventListener('click', clearAllData);

  // カテゴリモーダル
  document.getElementById('categoryModalClose').addEventListener('click', closeCategoryModal);
  document.getElementById('categoryModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeCategoryModal();
  });
  document.getElementById('addCategoryBtn').addEventListener('click', addCategory);

  // 検索モーダル
  document.getElementById('searchModalClose').addEventListener('click', closeSearchModal);
  document.getElementById('searchModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeSearchModal();
  });
  document.getElementById('searchInput').addEventListener('input', renderSearchResults);

  // カラーグリッド初期化
  renderColorGrid();
}

// ===================================================
//  ページ切り替え
// ===================================================
function switchPage(page) {
  // pages
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item[data-page]').forEach(btn => btn.classList.remove('active'));

  if (page === 'home') {
    document.getElementById('homePage').classList.add('active');
    document.querySelector('.nav-item[data-page="home"]').classList.add('active');
  } else if (page === 'settings') {
    document.getElementById('settingsPage').classList.add('active');
    document.querySelector('.nav-item[data-page="settings"]').classList.add('active');
    updateNotifSettingsUI();
  }
}

// ===================================================
//  ヘッダー日付
// ===================================================
function updateHeaderDate() {
  const now = new Date();
  const el  = document.getElementById('headerDate');
  el.textContent = now.toLocaleDateString('ja-JP', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'short'
  });
}

// ===================================================
//  タスクモーダル
// ===================================================
function openTaskModal(taskId = null) {
  editingTaskId = taskId;
  const modal   = document.getElementById('taskModal');
  const title   = document.getElementById('modalTitle');

  // カテゴリセレクトを最新状態で描画
  renderCategorySelect();

  if (taskId) {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    title.textContent = 'タスクを編集';
    document.getElementById('taskTitleInput').value  = task.title || '';
    document.getElementById('taskNoteInput').value   = task.note  || '';
    document.getElementById('taskDeadlineInput').value = task.deadline
      ? new Date(new Date(task.deadline).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)
      : '';

    // 優先度
    selectedPriority = task.priority || 'medium';
    document.querySelectorAll('#priorityChips .chip').forEach(c => {
      c.classList.toggle('selected', c.dataset.value === selectedPriority);
    });

    // カテゴリ
    selectedCategory = task.category || '';
    const catSel = document.getElementById('categorySelect');
    if (catSel) catSel.value = selectedCategory;

    // 繰り返し
    selectedRepeat = task.repeat || 'none';
    document.querySelectorAll('#repeatChips .chip').forEach(c => {
      c.classList.toggle('selected', c.dataset.value === selectedRepeat);
    });
    selectedCustomRepeat = task.customRepeat
      ? { ...task.customRepeat, weekdays: [...(task.customRepeat.weekdays || [])] }
      : { type: 'weekday', weekdays: [], interval: 1, unit: 'day' };
    document.getElementById('customRepeatPanel').style.display = selectedRepeat === 'custom' ? 'block' : 'none';
    if (selectedRepeat === 'custom') restoreCustomRepeatUI();

    // 見積もり時間
    selectedEstimate = task.estimate || 'none';
    document.querySelectorAll('#estimateChips .chip').forEach(c => {
      c.classList.toggle('selected', c.dataset.value === selectedEstimate);
    });
    document.getElementById('estimateHint').style.display = 'none';

  } else {
    title.textContent = 'タスクを追加';
    document.getElementById('taskTitleInput').value    = '';
    document.getElementById('taskNoteInput').value     = '';
    document.getElementById('taskDeadlineInput').value = '';
    selectedPriority     = 'medium';
    selectedCategory     = '';
    selectedRepeat       = 'none';
    selectedCustomRepeat = { type: 'weekday', weekdays: [], interval: 1, unit: 'day' };
    selectedEstimate     = 'none';
    document.getElementById('customRepeatPanel').style.display = 'none';
    document.querySelectorAll('#priorityChips .chip').forEach(c => {
      c.classList.toggle('selected', c.dataset.value === 'medium');
    });
    const catSelNew = document.getElementById('categorySelect');
    if (catSelNew) catSelNew.value = '';
    document.querySelectorAll('#repeatChips .chip').forEach(c => {
      c.classList.toggle('selected', c.dataset.value === 'none');
    });
    document.querySelectorAll('#estimateChips .chip').forEach(c => {
      c.classList.toggle('selected', c.dataset.value === 'none');
    });
    document.getElementById('estimateHint').style.display = 'none';
  }

  modal.classList.add('open');
  setTimeout(() => document.getElementById('taskTitleInput').focus(), 350);
}

function closeTaskModal() {
  document.getElementById('taskModal').classList.remove('open');
  editingTaskId = null;
}

function renderCategorySelect() {
  const sel = document.getElementById('categorySelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">カテゴリなし</option>';
  categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat.id;
    opt.textContent = cat.name;
    if (cat.id === selectedCategory) opt.selected = true;
    sel.appendChild(opt);
  });
}

// ===================================================
//  タスク保存
// ===================================================
function saveTask() {
  const title    = document.getElementById('taskTitleInput').value.trim();
  const note     = document.getElementById('taskNoteInput').value.trim();
  const deadline = document.getElementById('taskDeadlineInput').value;
  // カテゴリはセレクトボックスから取得
  selectedCategory = document.getElementById('categorySelect')?.value || '';

  if (!title) {
    showToast('タスク名を入力してください', 'error');
    document.getElementById('taskTitleInput').focus();
    return;
  }

  // 見積もり時間から期限を自動決定（手動期限が空の場合のみ）
  let finalDeadline = deadline ? new Date(deadline).toISOString() : null;
  if (!deadline && selectedEstimate !== 'none') {
    finalDeadline = calcDeadlineFromEstimate(selectedEstimate);
  }

  // カスタム繰り返しの最新値を反映
  if (selectedRepeat === 'custom') {
    selectedCustomRepeat.interval = parseInt(document.getElementById('intervalValue').value) || 1;
    selectedCustomRepeat.unit     = document.getElementById('intervalUnit').value;
  }
  const customRepeatData = selectedRepeat === 'custom' ? { ...selectedCustomRepeat, weekdays: [...selectedCustomRepeat.weekdays] } : null;

  if (editingTaskId) {
    const idx = tasks.findIndex(t => t.id === editingTaskId);
    if (idx !== -1) {
      tasks[idx] = {
        ...tasks[idx],
        title,
        note,
        deadline:     finalDeadline,
        priority:     selectedPriority,
        category:     selectedCategory,
        repeat:       selectedRepeat,
        customRepeat: customRepeatData,
        estimate:     selectedEstimate,
        updatedAt:    new Date().toISOString(),
      };
      showToast('✅ タスクを更新しました', 'success');
    }
  } else {
    const newTask = {
      id:        generateId(),
      title,
      note,
      deadline:     finalDeadline,
      priority:     selectedPriority,
      category:     selectedCategory,
      repeat:       selectedRepeat,
      customRepeat: customRepeatData,
      estimate:     selectedEstimate,
      completed:    false,
      completedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    tasks.unshift(newTask);
    showToast('🎉 タスクを追加しました', 'success');
  }

  saveData();
  closeTaskModal();
  renderAll();
}

// ===================================================
//  見積もり時間 → 期限自動計算
// ===================================================
const ESTIMATE_LABELS = {
  none:      '未設定',
  quick:     '⚡ 10分以内',
  today:     '🕐 〜1時間',
  twoweeks:  '📅 〜1日',
};

function calcDeadlineFromEstimate(estimate) {
  const now = new Date();
  switch (estimate) {
    case 'quick':
      // 今日中（今から30分後、最大EOD）
      return new Date(Math.min(
        now.getTime() + 30 * 60 * 1000,
        new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).getTime()
      )).toISOString();
    case 'today':
      // 今日の23:59
      return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0).toISOString();
    case 'twoweeks':
      // 2週間後の23:59
      const tw = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 14, 23, 59, 0);
      return tw.toISOString();
    default:
      return null;
  }
}

function applyEstimateToDeadline(estimate) {
  const hint = document.getElementById('estimateHint');
  const deadlineInput = document.getElementById('taskDeadlineInput');

  if (estimate === 'none') {
    hint.style.display = 'none';
    return;
  }

  const deadline = calcDeadlineFromEstimate(estimate);
  if (deadline && !deadlineInput.value) {
    // 手動入力がない場合だけ自動セット
    const local = new Date(new Date(deadline).getTime() - new Date().getTimezoneOffset() * 60000)
      .toISOString().slice(0, 16);
    deadlineInput.value = local;
  }

  const msgs = {
    quick:    '⚡ 10分以内のタスク → 今日中に自動設定',
    today:    '🕐 〜1時間のタスク → 今日の23:59に自動設定',
    twoweeks: '📅 〜1日のタスク → 2週間以内に自動設定',
  };
  hint.textContent   = msgs[estimate] || '';
  hint.style.display = 'block';
}

// ===================================================
//  タスク完了トグル
// ===================================================
function toggleTaskComplete(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;

  task.completed = !task.completed;
  task.completedAt = task.completed ? new Date().toISOString() : null;

  // 繰り返しタスクの場合: 次のタスクを生成
  if (task.completed && task.repeat && task.repeat !== 'none' && task.deadline) {
    const next = createRepeatTask(task);
    if (next) tasks.unshift(next);
  }

  saveData();
  renderAll();

  if (task.completed) {
    showToast('✅ タスクを完了しました！', 'success');
  }
}

function createRepeatTask(originalTask) {
  const deadline = new Date(originalTask.deadline);
  switch (originalTask.repeat) {
    case 'daily':   deadline.setDate(deadline.getDate() + 1); break;
    case 'weekly':  deadline.setDate(deadline.getDate() + 7); break;
    case 'monthly': deadline.setMonth(deadline.getMonth() + 1); break;
    case 'custom': {
      const cr = originalTask.customRepeat;
      if (!cr) return null;
      if (cr.type === 'interval') {
        const n = cr.interval || 1;
        if (cr.unit === 'day')   deadline.setDate(deadline.getDate() + n);
        if (cr.unit === 'week')  deadline.setDate(deadline.getDate() + n * 7);
        if (cr.unit === 'month') deadline.setMonth(deadline.getMonth() + n);
      } else if (cr.type === 'weekday' && cr.weekdays && cr.weekdays.length > 0) {
        // 次の該当曜日を探す（翌日以降）
        const next = new Date(deadline);
        next.setDate(next.getDate() + 1);
        for (let i = 0; i < 7; i++) {
          if (cr.weekdays.includes(next.getDay())) break;
          next.setDate(next.getDate() + 1);
        }
        return { ...originalTask, id: generateId(), completed: false, completedAt: null,
          deadline: next.toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      } else { return null; }
      break;
    }
    default: return null;
  }
  return {
    ...originalTask,
    id:          generateId(),
    completed:   false,
    completedAt: null,
    deadline:    deadline.toISOString(),
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
  };
}

// カスタム繰り返しのラベル生成
function getRepeatLabel(task) {
  if (task.repeat !== 'custom') return REPEAT_LABELS[task.repeat] || task.repeat;
  const cr = task.customRepeat;
  if (!cr) return 'カスタム';
  if (cr.type === 'interval') {
    const units = { day: '日', week: '週', month: 'ヶ月' };
    return `${cr.interval}${units[cr.unit] || cr.unit}ごと`;
  }
  if (cr.type === 'weekday' && cr.weekdays && cr.weekdays.length > 0) {
    return cr.weekdays.slice().sort((a, b) => a - b).map(d => DAY_NAMES[d]).join('・') + '曜';
  }
  return 'カスタム';
}

// カスタム繰り返しUIを保存済みデータから復元
function restoreCustomRepeatUI() {
  const cr = selectedCustomRepeat;
  // タイプボタン
  document.querySelectorAll('#customRepeatPanel [data-ctype]').forEach(b => {
    b.classList.toggle('selected', b.dataset.ctype === cr.type);
  });
  document.getElementById('weekdayPanel').style.display  = cr.type === 'weekday'  ? 'block' : 'none';
  document.getElementById('intervalPanel').style.display = cr.type === 'interval' ? 'block' : 'none';
  // 曜日ボタン
  document.querySelectorAll('#weekdayPanel [data-day]').forEach(b => {
    b.classList.toggle('selected', cr.weekdays.includes(parseInt(b.dataset.day)));
  });
  // 間隔
  document.getElementById('intervalValue').value = cr.interval || 1;
  document.getElementById('intervalUnit').value  = cr.unit || 'day';
}

// ===================================================
//  タスク削除
// ===================================================
function deleteTask(taskId) {
  if (!confirm('このタスクを削除しますか？')) return;
  tasks = tasks.filter(t => t.id !== taskId);
  saveData();
  renderAll();
  showToast('🗑️ タスクを削除しました', 'warning');
}

// ===================================================
//  レンダリング
// ===================================================
function renderAll() {
  renderStats();
  renderTaskList();
}

function renderStats() {
  const now   = new Date();
  const today = getDateString(now);

  const overdue = tasks.filter(t => !t.completed && t.deadline && new Date(t.deadline) < now && getDateString(new Date(t.deadline)) !== today).length;
  const todayCnt = tasks.filter(t => !t.completed && t.deadline && getDateString(new Date(t.deadline)) === today).length;
  const done  = tasks.filter(t => t.completed).length;

  document.getElementById('statOverdue').textContent = overdue;
  document.getElementById('statToday').textContent   = todayCnt;
  document.getElementById('statDone').textContent    = done;
}

function getFilteredTasks() {
  const now   = new Date();
  const today = getDateString(now);

  // 今日の終わり
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  // 2週間後の終わり
  const endOf2Weeks = new Date(endOfToday);
  endOf2Weeks.setDate(endOf2Weeks.getDate() + 14);

  switch (currentFilter) {
    // ⚡ すぐやる：見積もりが「10分以内」のタスク
    case 'quick':
      return tasks.filter(t => !t.completed && t.estimate === 'quick');

    // 🕐 今日中：見積もりが「〜1時間」 or 今日が期限のタスク
    case 'today':
      return tasks.filter(t => {
        if (t.completed) return false;
        if (t.estimate === 'today') return true;
        if (t.deadline) {
          const dl = new Date(t.deadline);
          return dl <= endOfToday;
        }
        return false;
      });

    // 📅 2週間以内：見積もりが「〜1日」 or 2週間以内に期限
    case 'twoweeks':
      return tasks.filter(t => {
        if (t.completed) return false;
        if (t.estimate === 'twoweeks') return true;
        if (t.deadline) {
          const dl = new Date(t.deadline);
          return dl <= endOf2Weeks;
        }
        return false;
      });

    case 'all':
      return tasks.filter(t => !t.completed);

    case 'done':
      return tasks.filter(t => t.completed);

    default:
      return tasks.filter(t => !t.completed);
  }
}

function renderTaskList() {
  const container = document.getElementById('taskListContainer');
  const filtered  = getFilteredTasks();

  // ソート: 優先度 > 期限
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  filtered.sort((a, b) => {
    // まず期限切れを先に
    const now = new Date();
    const aOver = a.deadline && new Date(a.deadline) < now;
    const bOver = b.deadline && new Date(b.deadline) < now;
    if (aOver && !bOver) return -1;
    if (!aOver && bOver) return 1;
    // 次に期限
    if (a.deadline && b.deadline) {
      const diff = new Date(a.deadline) - new Date(b.deadline);
      if (diff !== 0) return diff;
    }
    if (a.deadline && !b.deadline) return -1;
    if (!a.deadline && b.deadline) return 1;
    // 優先度
    return (priorityOrder[a.priority] || 1) - (priorityOrder[b.priority] || 1);
  });

  container.innerHTML = '';

  // グループ分け（今日・今後・期限なし・完了）
  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <div class="empty-title">タスクがありません</div>
        <div class="empty-desc">＋ボタンからタスクを追加しましょう</div>
      </div>`;
    return;
  }

  const now   = new Date();
  const today = getDateString(now);

  // セクション分け
  const sections = [
    { key: 'overdue',    label: '⚠️ 期限切れ',   tasks: [] },
    { key: 'today',      label: '📅 今日',         tasks: [] },
    { key: 'upcoming',   label: '🗓️ 今後',         tasks: [] },
    { key: 'no-deadline', label: '📌 期限なし',    tasks: [] },
    { key: 'completed',  label: '✅ 完了済み',     tasks: [] },
  ];

  filtered.forEach(task => {
    if (task.completed) {
      sections.find(s => s.key === 'completed').tasks.push(task);
    } else if (!task.deadline) {
      sections.find(s => s.key === 'no-deadline').tasks.push(task);
    } else {
      const dl = new Date(task.deadline);
      if (getDateString(dl) === today) {
        sections.find(s => s.key === 'today').tasks.push(task);
      } else if (dl < now) {
        sections.find(s => s.key === 'overdue').tasks.push(task);
      } else {
        sections.find(s => s.key === 'upcoming').tasks.push(task);
      }
    }
  });

  sections.forEach(section => {
    if (section.tasks.length === 0) return;

    const header = document.createElement('div');
    header.className = 'section-header';
    header.innerHTML = `
      <span class="section-title">${section.label}</span>
      <span class="section-badge">${section.tasks.length}</span>`;
    container.appendChild(header);

    const list = document.createElement('div');
    list.className = 'task-list';
    section.tasks.forEach(task => {
      list.appendChild(createTaskCard(task));
    });
    container.appendChild(list);
  });
}

function createTaskCard(task) {
  const now    = new Date();
  const today  = getDateString(now);
  const isOverdue   = !task.completed && task.deadline && new Date(task.deadline) < now && getDateString(new Date(task.deadline)) !== today;
  const isDueToday  = !task.completed && task.deadline && getDateString(new Date(task.deadline)) === today;

  const card = document.createElement('div');
  card.className = `task-card priority-${task.priority || 'medium'}${isOverdue ? ' overdue' : ''}${isDueToday ? ' due-today' : ''}${task.completed ? ' completed' : ''}`;
  card.setAttribute('role', 'article');
  card.setAttribute('aria-label', task.title);

  // デッドライン表示
  let deadlineHtml = '';
  if (task.deadline) {
    const dl   = new Date(task.deadline);
    const dlStr = isOverdue
      ? `⚠️ ${formatDeadline(dl)} (期限切れ)`
      : isDueToday
        ? `🔥 ${formatDeadline(dl)} (今日まで)`
        : `📅 ${formatDeadline(dl)}`;
    const cls = isOverdue ? 'overdue' : isDueToday ? 'due-today' : '';
    deadlineHtml = `<span class="task-deadline ${cls}">${dlStr}</span>`;
  }

  // カテゴリバッジ
  let catHtml = '';
  if (task.category) {
    const cat = categories.find(c => c.id === task.category);
    if (cat) {
      catHtml = `<span class="task-badge badge-category" style="background:${hexToRgba(cat.color, 0.15)};color:${cat.color};border-color:${hexToRgba(cat.color, 0.4)}">${cat.name}</span>`;
    }
  }

  // 繰り返しバッジ
  const repeatHtml = task.repeat && task.repeat !== 'none'
    ? `<span class="task-badge badge-repeat">🔁 ${getRepeatLabel(task)}</span>`
    : '';

  // 見積もり時間バッジ
  const estimateStyles = {
    quick:    'background:rgba(234,179,8,0.15);color:#eab308;border-color:rgba(234,179,8,0.4)',
    today:    'background:rgba(249,115,22,0.15);color:#f97316;border-color:rgba(249,115,22,0.4)',
    twoweeks: 'background:rgba(59,130,246,0.15);color:#3b82f6;border-color:rgba(59,130,246,0.4)',
  };
  const estimateHtml = task.estimate && task.estimate !== 'none' && ESTIMATE_LABELS[task.estimate]
    ? `<span class="task-badge" style="${estimateStyles[task.estimate] || ''}">${ESTIMATE_LABELS[task.estimate]}</span>`
    : '';

  // 優先度バッジ
  const priorityHtml = `<span class="task-badge badge-priority-${task.priority || 'medium'}">
    ${task.priority === 'high' ? '🔴' : task.priority === 'low' ? '🟢' : '🟡'} ${PRIORITY_LABELS[task.priority] || '中'}</span>`;

  card.innerHTML = `
    <div class="task-header">
      <div class="task-checkbox${task.completed ? ' checked' : ''}" role="checkbox" aria-checked="${task.completed}" data-id="${task.id}"></div>
      <div class="task-body">
        <div class="task-title">${escapeHtml(task.title)}</div>
        ${task.note ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${escapeHtml(task.note)}</div>` : ''}
        <div class="task-meta">
          ${catHtml}
          ${estimateHtml}
          ${priorityHtml}
          ${repeatHtml}
          ${deadlineHtml}
        </div>
      </div>
      <div class="task-actions">
        <button class="task-action-btn edit" data-id="${task.id}" aria-label="編集">✏️</button>
        <button class="task-action-btn delete" data-id="${task.id}" aria-label="削除">🗑️</button>
      </div>
    </div>`;

  // イベント
  card.querySelector('.task-checkbox').addEventListener('click', e => {
    e.stopPropagation();
    toggleTaskComplete(task.id);
  });
  card.querySelector('.edit').addEventListener('click', e => {
    e.stopPropagation();
    openTaskModal(task.id);
  });
  card.querySelector('.delete').addEventListener('click', e => {
    e.stopPropagation();
    deleteTask(task.id);
  });
  card.addEventListener('click', () => openTaskModal(task.id));

  return card;
}

// ===================================================
//  検索
// ===================================================
function openSearchModal() {
  const modal = document.getElementById('searchModal');
  modal.classList.add('open');
  document.getElementById('searchResults').innerHTML = '';
  document.getElementById('searchInput').value = '';
  setTimeout(() => document.getElementById('searchInput').focus(), 350);
}

function closeSearchModal() {
  document.getElementById('searchModal').classList.remove('open');
}

function renderSearchResults() {
  const query   = document.getElementById('searchInput').value.toLowerCase().trim();
  const container = document.getElementById('searchResults');

  if (!query) {
    container.innerHTML = '';
    return;
  }

  const results = tasks.filter(t =>
    t.title.toLowerCase().includes(query) ||
    (t.note && t.note.toLowerCase().includes(query))
  );

  if (results.length === 0) {
    container.innerHTML = `<div class="empty-state" style="padding:24px 0"><div class="empty-icon" style="font-size:32px">🔍</div><div class="empty-desc">「${escapeHtml(query)}」に一致するタスクはありません</div></div>`;
    return;
  }

  container.innerHTML = '';
  results.forEach(task => container.appendChild(createTaskCard(task)));
}

// ===================================================
//  カテゴリ管理モーダル
// ===================================================
function openCategoryModal() {
  renderCategoryManager();
  renderColorGrid();
  document.getElementById('categoryModal').classList.add('open');
}

function closeCategoryModal() {
  document.getElementById('categoryModal').classList.remove('open');
  renderCategorySelect();
  renderAll();
}

function renderCategoryManager() {
  const container = document.getElementById('categoryListEl');
  container.innerHTML = '';

  categories.forEach(cat => {
    const item = document.createElement('div');
    item.className = 'category-item';
    item.innerHTML = `
      <span class="cat-dot" style="background:${cat.color}"></span>
      <span class="category-item-name">${escapeHtml(cat.name)}</span>
      <button class="category-delete-btn" data-id="${cat.id}" aria-label="削除">🗑️</button>`;
    item.querySelector('.category-delete-btn').addEventListener('click', () => {
      if (cat.id === 'work' || cat.id === 'private' || cat.id === 'study') {
        showToast('デフォルトカテゴリは削除できません', 'error');
        return;
      }
      categories = categories.filter(c => c.id !== cat.id);
      saveCategories();
      renderCategoryManager();
      showToast('カテゴリを削除しました', 'warning');
    });
    container.appendChild(item);
  });
}

function renderColorGrid() {
  const grid = document.getElementById('colorGrid');
  if (!grid) return;
  grid.innerHTML = '';
  CATEGORY_COLORS.forEach(color => {
    const swatch = document.createElement('div');
    swatch.className = `color-swatch${color === selectedColor ? ' selected' : ''}`;
    swatch.style.background = color;
    swatch.setAttribute('role', 'radio');
    swatch.setAttribute('aria-checked', color === selectedColor);
    swatch.addEventListener('click', () => {
      selectedColor = color;
      document.querySelectorAll('.color-swatch').forEach(s => {
        const isSelected = s.style.background === color || s.style.backgroundColor === color;
        s.classList.toggle('selected', isSelected);
        s.setAttribute('aria-checked', isSelected);
      });
    });
    grid.appendChild(swatch);
  });
}

function addCategory() {
  const name = document.getElementById('newCategoryName').value.trim();
  if (!name) {
    showToast('カテゴリ名を入力してください', 'error');
    return;
  }
  if (categories.some(c => c.name === name)) {
    showToast('同じ名前のカテゴリが既に存在します', 'error');
    return;
  }
  const newCat = {
    id:    `cat_${Date.now()}`,
    name,
    color: selectedColor,
  };
  categories.push(newCat);
  saveCategories();
  document.getElementById('newCategoryName').value = '';
  renderCategoryManager();
  showToast(`🏷️ カテゴリ「${name}」を追加しました`, 'success');
}

// ===================================================
//  データ エクスポート / インポート
// ===================================================
function exportData() {
  const data = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    tasks,
    categories,
  };
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `taskflow_backup_${getDateString(new Date())}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('📤 データをエクスポートしました', 'success');
}

function exportCSV() {
  const headers = ['タイトル', 'メモ', '期限', '優先度', 'カテゴリ', '繰り返し', '完了', '完了日時', '作成日時'];
  const rows = tasks.map(t => {
    const cat = categories.find(c => c.id === t.category);
    const fmt = v => v ? new Date(v).toLocaleString('ja-JP') : '';
    return [
      t.title   || '',
      t.note    || '',
      fmt(t.deadline),
      PRIORITY_LABELS[t.priority] || t.priority || '',
      cat ? cat.name : (t.category || ''),
      getRepeatLabel(t) || 'なし',
      t.completed ? '完了' : '未完了',
      fmt(t.completedAt),
      fmt(t.createdAt),
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
  });
  // BOM付きUTF-8でExcelでも文字化けしない
  const csv  = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `taskflow_${getDateString(new Date())}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('📊 CSVをエクスポートしました', 'success');
}

function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!data.tasks || !Array.isArray(data.tasks)) throw new Error('invalid format');
      if (!confirm(`${data.tasks.length}件のタスクをインポートします。現在のタスクに追加されます。`)) return;
      tasks = [...data.tasks, ...tasks];
      if (data.categories) {
        // マージ（重複回避）
        data.categories.forEach(cat => {
          if (!categories.find(c => c.id === cat.id)) categories.push(cat);
        });
        saveCategories();
      }
      saveData();
      renderAll();
      showToast(`📥 ${data.tasks.length}件のタスクをインポートしました`, 'success');
    } catch {
      showToast('インポートに失敗しました（不正なファイル）', 'error');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

function clearAllData() {
  if (!confirm('⚠️ 全タスクを削除します。この操作は取り消せません。続行しますか？')) return;
  if (!confirm('本当に削除しますか？')) return;
  tasks = [];
  saveData();
  renderAll();
  showToast('🗑️ 全データを削除しました', 'warning');
}

// ===================================================
//  Utility
// ===================================================
function generateId() {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getDateString(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDeadline(date) {
  const now   = new Date();
  const today = getDateString(now);
  const ds    = getDateString(date);

  if (ds === today) {
    return `今日 ${date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (ds === getDateString(tomorrow)) {
    return `明日 ${date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
  }

  return date.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hexToRgba(hex, alpha = 1) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? `rgba(${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}, ${alpha})`
    : hex;
}

// ===================================================
//  Toast 通知
// ===================================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast     = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 3000);
}

// ===================================================
//  サンプルタスク（初回起動時）
// ===================================================
function addSampleTasksIfEmpty() {
  if (tasks.length > 0) return;

  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const samples = [
    {
      id: generateId(),
      title: '友達にLINEを返信する',
      note: 'すぐ返せる！',
      deadline: new Date(today.getTime() + 23 * 60 * 60 * 1000).toISOString(),
      priority: 'medium',
      category: 'private',
      repeat: 'none',
      estimate: 'quick',
      completed: false,
      completedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: generateId(),
      title: 'メールを確認・返信',
      note: '重要なメール3件',
      deadline: new Date(today.getTime() + 23 * 60 * 60 * 1000).toISOString(),
      priority: 'high',
      category: 'work',
      repeat: 'none',
      estimate: 'quick',
      completed: false,
      completedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: generateId(),
      title: '朝のウォーキング 30分',
      note: 'ストレッチも忘れずに',
      deadline: new Date(today.getTime() + 23 * 60 * 60 * 1000).toISOString(),
      priority: 'high',
      category: 'health',
      repeat: 'daily',
      estimate: 'today',
      completed: false,
      completedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: generateId(),
      title: 'JavaScript の勉強',
      note: 'MDNでPromiseの復習（1時間）',
      deadline: new Date(today.getTime() + 23 * 60 * 60 * 1000).toISOString(),
      priority: 'medium',
      category: 'study',
      repeat: 'none',
      estimate: 'today',
      completed: false,
      completedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: generateId(),
      title: '週次レポートの作成',
      note: '先週の進捗をまとめる（丸一日かかる）',
      deadline: new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000 + 17 * 60 * 60 * 1000).toISOString(),
      priority: 'high',
      category: 'work',
      repeat: 'weekly',
      estimate: 'twoweeks',
      completed: false,
      completedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: generateId(),
      title: '引越しの準備',
      note: '荷物の仕分けから梱包まで（1日かかる）',
      deadline: new Date(today.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString(),
      priority: 'high',
      category: 'private',
      repeat: 'none',
      estimate: 'twoweeks',
      completed: false,
      completedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  tasks = samples;
  saveData();
}

// （初回起動チェックは DOMContentLoaded 内で統合済み）

/**
 * TaskFlow Service Worker
 * - キャッシュ管理（オフライン対応）
 * - 通知スケジューリング（朝9時・夜17時）
 */

const CACHE_NAME = 'taskflow-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.svg',
  './icons/icon-512.svg'
];

// ===== インストール =====
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

// ===== アクティベート =====
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    }).then(() => {
      self.clients.claim();
      // スケジュール開始
      scheduleNotifications();
    })
  );
});

// ===== フェッチ（オフラインキャッシュ） =====
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request).catch(() => cached);
    })
  );
});

// ===== メッセージ受信 =====
self.addEventListener('message', event => {
  const { type, payload } = event.data || {};

  switch (type) {
    case 'SCHEDULE_NOTIFICATIONS':
      scheduleNotifications();
      break;
    case 'SEND_MORNING_NOTIFICATION':
      sendMorningNotification(payload);
      break;
    case 'SEND_EVENING_NOTIFICATION':
      sendEveningNotification(payload);
      break;
    case 'TEST_NOTIFICATION':
      sendTestNotification();
      break;
  }
});

// ===== 通知クリック =====
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      if (clientList.length > 0) {
        return clientList[0].focus();
      }
      return clients.openWindow('./');
    })
  );
});

// ===== 通知スケジューリング =====
let morningTimer = null;
let eveningTimer = null;

function scheduleNotifications() {
  // 既存タイマーをクリア
  if (morningTimer) clearTimeout(morningTimer);
  if (eveningTimer) clearTimeout(eveningTimer);

  const now = new Date();

  // 朝9時の通知
  const morning = new Date(now);
  morning.setHours(9, 0, 0, 0);
  if (morning <= now) morning.setDate(morning.getDate() + 1);
  const msToMorning = morning - now;

  morningTimer = setTimeout(() => {
    requestTaskDataAndSendMorning();
    // 翌日も繰り返す
    setInterval(() => requestTaskDataAndSendMorning(), 24 * 60 * 60 * 1000);
  }, msToMorning);

  // 夜17時の通知
  const evening = new Date(now);
  evening.setHours(17, 0, 0, 0);
  if (evening <= now) evening.setDate(evening.getDate() + 1);
  const msToEvening = evening - now;

  eveningTimer = setTimeout(() => {
    requestTaskDataAndSendEvening();
    setInterval(() => requestTaskDataAndSendEvening(), 24 * 60 * 60 * 1000);
  }, msToEvening);
}

// クライアントにタスクデータを要求して通知
function requestTaskDataAndSendMorning() {
  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
    if (clientList.length > 0) {
      clientList[0].postMessage({ type: 'REQUEST_MORNING_DATA' });
    } else {
      // クライアントが起動していない場合は汎用通知
      self.registration.showNotification('🌅 おはようございます！', {
        body: 'TaskFlowを開いて今日のタスクを確認しましょう！',
        icon: './icons/icon-192.svg',
        badge: './icons/icon-72.svg',
        tag: 'morning-tasks',
        requireInteraction: true,
        data: { type: 'morning' }
      });
    }
  });
}

function requestTaskDataAndSendEvening() {
  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
    if (clientList.length > 0) {
      clientList[0].postMessage({ type: 'REQUEST_EVENING_DATA' });
    } else {
      self.registration.showNotification('🌇 お疲れ様でした！', {
        body: 'TaskFlowを開いて今日の振り返りをしましょう！',
        icon: './icons/icon-192.svg',
        badge: './icons/icon-72.svg',
        tag: 'evening-tasks',
        requireInteraction: true,
        data: { type: 'evening' }
      });
    }
  });
}

// ===== 朝の通知送信 =====
function sendMorningNotification(data) {
  const { todayTasks = [], overdueTasks = [] } = data || {};
  const total = todayTasks.length + overdueTasks.length;

  let body = '';
  if (total === 0) {
    body = '今日の予定タスクはありません。素敵な一日を！🎉';
  } else {
    const lines = [];
    if (todayTasks.length > 0) {
      lines.push(`📋 今日のタスク: ${todayTasks.length}件`);
      todayTasks.slice(0, 3).forEach(t => lines.push(`  • ${t.title}`));
      if (todayTasks.length > 3) lines.push(`  ...他 ${todayTasks.length - 3}件`);
    }
    if (overdueTasks.length > 0) {
      lines.push(`⚠️ 期限切れ: ${overdueTasks.length}件`);
    }
    body = lines.join('\n');
  }

  return self.registration.showNotification('🌅 おはようございます！今日のタスク', {
    body,
    icon: './icons/icon-192.svg',
    badge: './icons/icon-72.svg',
    tag: 'morning-tasks',
    requireInteraction: true,
    data: { type: 'morning' }
  });
}

// ===== 夜の通知送信 =====
function sendEveningNotification(data) {
  const { completedToday = 0, remainingTasks = [] } = data || {};

  let body = '';
  const lines = [];

  if (completedToday > 0) {
    lines.push(`✅ 今日完了: ${completedToday}件 素晴らしい！`);
  }

  if (remainingTasks.length === 0) {
    lines.push('🎊 全タスク完了！今日もお疲れ様でした！');
  } else {
    lines.push(`📌 残りタスク: ${remainingTasks.length}件`);
    remainingTasks.slice(0, 3).forEach(t => lines.push(`  • ${t.title}`));
    if (remainingTasks.length > 3) lines.push(`  ...他 ${remainingTasks.length - 3}件`);
  }

  body = lines.join('\n');

  return self.registration.showNotification('🌇 お疲れ様でした！今日の振り返り', {
    body,
    icon: './icons/icon-192.svg',
    badge: './icons/icon-72.svg',
    tag: 'evening-tasks',
    requireInteraction: true,
    data: { type: 'evening' }
  });
}

// ===== テスト通知 =====
function sendTestNotification() {
  return self.registration.showNotification('🔔 通知テスト', {
    body: 'TaskFlowの通知が正常に動作しています！',
    icon: './icons/icon-192.svg',
    badge: './icons/icon-72.svg',
    tag: 'test-notification'
  });
}

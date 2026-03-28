// firebase-messaging-sw.js
// Service Worker pour les notifications push Firebase (background)
// À placer à la RACINE du projet (même niveau que index.html)

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCrnYa3VYKZlZer1R1H-k7IcTLmGaho3Qs",
  authDomain: "gold-pixel.firebaseapp.com",
  projectId: "gold-pixel",
  storageBucket: "gold-pixel.firebasestorage.app",
  messagingSenderId: "483082801795",
  appId: "1:483082801795:web:96e6ba329bab67e53841b6"
});

const messaging = firebase.messaging();

// Gérer les messages reçus en background (app fermée ou en arrière-plan)
messaging.onBackgroundMessage(payload => {
  console.log('[FCM SW] Message reçu en background:', payload);

  const title = payload.notification?.title || '✦ Gold Pixel';
  const body  = payload.notification?.body  || 'Nouvelle notification';

  self.registration.showNotification(title, {
    body,
    icon: '/Images/Logo_Gold_Pixel_Final.jpg',
    badge: '/Images/Logo_Gold_Pixel_Final.jpg',
    tag: 'gold-pixel-notif',          // remplace la notif précédente si déjà affichée
    renotify: false,
    data: payload.data || {},
  });
});

// Clic sur la notification → ouvrir le jeu
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Si le jeu est déjà ouvert, le mettre au premier plan
      for (const client of list) {
        if (client.url.includes('goldpixel') && 'focus' in client) {
          return client.focus();
        }
      }
      // Sinon ouvrir une nouvelle fenêtre
      if (clients.openWindow) {
        return clients.openWindow('/goldpixel');
      }
    })
  );
});

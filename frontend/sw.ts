/// <reference lib="webworker" />

importScripts('sw-runtime-resources-precache.js');
import { clientsClaim, RouteHandlerCallbackOptions } from 'workbox-core';
import { matchPrecache, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { PrecacheEntry } from 'workbox-precaching/_types';
import { NetworkOnly } from 'workbox-strategies';

declare var self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<PrecacheEntry>;
  additionalManifestEntries?: Array<PrecacheEntry>;
};

declare var OFFLINE_PATH: string; // defined by webpack.generated.js

let connectionLost = false;

self.skipWaiting().then(() => {
  clientsClaim();

  /**
   * Replaces <base href> in pre-cached response HTML with the service worker’s
   * scope URL.
   *
   * @param response HTML response to modify
   * @returns modified response
   */
  const rewriteBaseHref = async (response: Response) => {
    const html = await response.text();
    return new Response(html.replace(/<base\s+href=[^>]*>/, `<base href="${self.registration.scope}">`), response);
  };

  const offlinePath = OFFLINE_PATH;
  const networkOnly = new NetworkOnly();

//@ts-ignore
  const navigationFallback = new NavigationRoute(async (context: RouteHandlerCallbackOptions) => {
    const serveResourceFromCache = async () => {
      // serve any file in the manifest directly from cache
      const path = context.url.pathname;
      const scopePath = new URL(self.registration.scope).pathname;
      if (path.startsWith(scopePath)) {
        const pathRelativeToScope = path.substring(scopePath.length);
        if (manifestEntries.some(({ url }) => url === pathRelativeToScope)) {
          return await matchPrecache(pathRelativeToScope);
        }
      }
      const offlinePathPrecachedResponse = await matchPrecache(offlinePath);
      if (offlinePathPrecachedResponse) {
        return await rewriteBaseHref(offlinePathPrecachedResponse);
      }
      return undefined;
    };

    // Use offlinePath fallback if offline was detected
    if (!self.navigator.onLine) {
      const precachedResponse = await serveResourceFromCache();
      if (precachedResponse) {
        return precachedResponse;
      }
    }

    // Sometimes navigator.onLine is not reliable, use fallback to offlinePath
    // also in case of network failure
    try {
      const response = await networkOnly.handle(context);
      connectionLost = false;
      return response;
    } catch (error) {
      connectionLost = true;
      const precachedResponse = await serveResourceFromCache();
      return precachedResponse || error;
    }
  });

  registerRoute(navigationFallback);

  let manifestEntries: Array<PrecacheEntry> = self.__WB_MANIFEST || [];
  if (self.additionalManifestEntries && self.additionalManifestEntries.length) {
    manifestEntries = [...manifestEntries, ...self.additionalManifestEntries];
  }

  precacheAndRoute(manifestEntries);
});


self.addEventListener('message', (event) => {
  if (typeof event.data !== 'object' || !('method' in event.data)) {
    return;
  }

  // JSON-RPC request handler for ConnectionStateStore
  if (event.data.method === 'Vaadin.ServiceWorker.isConnectionLost' && 'id' in event.data) {
    event.source?.postMessage({ id: event.data.id, result: connectionLost }, []);
  }
});

// Handle web push

self.addEventListener('push', (e) => {
  const data = e.data?.json();
  if (data) {
    self.registration.showNotification(data.title, {
      body: data.body,
    });
  }
});

self.addEventListener('notificationclick', (e) => {
  async function focusOrOpenWindow() {
    const url = new URL('/', self.location.origin).href;

    const allWindows = await self.clients.matchAll({
      type: 'window',
    });
    const appWindow = allWindows.find((w) => w.url === url);

    if (appWindow) {
      return appWindow.focus();
    } else {
      return self.clients.openWindow(url);
    }
  }

  e.notification.close();
  e.waitUntil(focusOrOpenWindow());
});
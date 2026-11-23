/**
 * @file 启动工作台渲染进程。
 * @implementation 在挂载前应用语言偏好，装配路由、查询与工作区状态，并异步加载遵从系统偏好的局部动效。
 * @updated 2026-11-23T05:01:49+08:00
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, MotionConfig } from 'motion/react';
import { store } from './app/store';
import { RouterProvider } from '@tanstack/react-router';
import { workspaceRouter } from './app/workspace-router';
import { initializeUiLanguage } from './i18n';
import { initializeUiTheme, initializeUiThemeSync } from './theme';
import { initializeUiNotifications, initializeUiNotificationsSync } from './notifications';
import './styles.css';

initializeUiThemeSync();
initializeUiNotificationsSync();

const client = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, retry: false, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});

const loadMotionFeatures = () =>
  import('./components/ui/motion-features').then((module) => module.domAnimation);

const root = document.getElementById('root');
if (root) {
  void Promise.all([
    initializeUiLanguage(),
    initializeUiTheme(),
    initializeUiNotifications(),
  ]).then(() => {
    createRoot(root).render(
      <StrictMode>
        <MotionConfig reducedMotion="user">
          <LazyMotion features={loadMotionFeatures} strict>
            <QueryClientProvider client={client}>
              <Provider store={store}>
                <RouterProvider router={workspaceRouter} />
              </Provider>
            </QueryClientProvider>
          </LazyMotion>
        </MotionConfig>
      </StrictMode>,
    );
  });
}

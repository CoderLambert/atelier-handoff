import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { store } from './app/store';
import Workspace from './app/workspace';
import './styles.css';

const client = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, retry: false, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <Provider store={store}>
        <Workspace />
      </Provider>
    </QueryClientProvider>
  </StrictMode>,
);

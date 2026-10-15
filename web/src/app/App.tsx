// Root component: providers + route table. Pages are lazy-loaded per feature.

import { QueryClientProvider } from '@tanstack/react-query';
import { type ComponentType } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { AuthedApp } from './AuthedApp';
import { retryableLazy } from './chunkErrors';
import { queryClient } from './queryClient';
import { PublicOnly } from './PublicOnly';
import { RouteError } from './RouteError';

/** A lazy-loaded page whose chunk is imported again after a failed load (offline, upgrade). */
function lazyPage(load: () => Promise<{ default: ComponentType }>): ComponentType {
  const loader = retryableLazy(load);
  return function LazyPage() {
    const Page = loader.current();
    return <Page />;
  };
}

const LoginPage = lazyPage(() => import('../features/auth/LoginPage'));
const SetupPage = lazyPage(() => import('../features/auth/SetupPage'));
const HomeRedirect = lazyPage(() => import('../features/home/HomeRedirect'));
const DashboardPage = lazyPage(() => import('../features/dashboard/DashboardPage'));
const ProjectsPage = lazyPage(() => import('../features/projects/ProjectsPage'));
const ProjectLayout = lazyPage(() => import('../features/projects/ProjectLayout'));
const ProjectOverview = lazyPage(() => import('../features/projects/ProjectOverview'));
const ProjectTasksPage = lazyPage(() => import('../features/projects/ProjectTasksPage'));
const ProjectActivityPage = lazyPage(() => import('../features/projects/ProjectActivityPage'));
const MilestonePage = lazyPage(() => import('../features/projects/MilestonePage'));
const EpicPage = lazyPage(() => import('../features/projects/EpicPage'));
const ProjectBoardPage = lazyPage(() => import('../features/boards/ProjectBoardPage'));
const BoardsPage = lazyPage(() => import('../features/boards/BoardsPage'));
const BoardPage = lazyPage(() => import('../features/boards/BoardPage'));
const TaskPage = lazyPage(() => import('../features/tasks/TaskPage'));
const ActivityPage = lazyPage(() => import('../features/timeline/ActivityPage'));
const WorklogPage = lazyPage(() => import('../features/timeline/WorklogPage'));
const SettingsLayout = lazyPage(() => import('../features/settings/SettingsLayout'));
const AccountSettings = lazyPage(() => import('../features/settings/AccountSettings'));
const PreferencesSettings = lazyPage(() => import('../features/settings/PreferencesSettings'));
const StatusSettings = lazyPage(() => import('../features/settings/StatusSettings'));
const TagSettings = lazyPage(() => import('../features/settings/TagSettings'));
const DataSettings = lazyPage(() => import('../features/settings/DataSettings'));
const NotFoundPage = lazyPage(() => import('../features/common/NotFoundPage'));

const router = createBrowserRouter([
  {
    element: <PublicOnly />,
    errorElement: <RouteError variant="full" />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/setup', element: <SetupPage /> },
    ],
  },
  {
    element: <AuthedApp />,
    // Errors in the shell itself (sidebar, gates) replace the whole screen…
    errorElement: <RouteError variant="full" />,
    children: [
      {
        // …while a page that fails keeps the shell (sidebar, bottom bar) around its error.
        errorElement: <RouteError />,
        children: [
          { index: true, element: <HomeRedirect /> },
          { path: 'dashboard', element: <DashboardPage /> },
          { path: 'projects', element: <ProjectsPage /> },
          {
            path: 'projects/:projectId',
            element: <ProjectLayout />,
            children: [
              { index: true, element: <ProjectOverview /> },
              { path: 'board', element: <ProjectBoardPage /> },
              { path: 'tasks', element: <ProjectTasksPage /> },
              { path: 'activity', element: <ProjectActivityPage /> },
              { path: 'milestones/:milestoneId', element: <MilestonePage /> },
              { path: 'epics/:epicId', element: <EpicPage /> },
            ],
          },
          { path: 'boards', element: <BoardsPage /> },
          { path: 'boards/:boardId', element: <BoardPage /> },
          { path: 'tasks/:taskKey', element: <TaskPage /> },
          { path: 'activity', element: <ActivityPage /> },
          { path: 'worklog', element: <WorklogPage /> },
          {
            path: 'settings',
            element: <SettingsLayout />,
            children: [
              { index: true, element: <AccountSettings /> },
              { path: 'preferences', element: <PreferencesSettings /> },
              { path: 'statuses', element: <StatusSettings /> },
              { path: 'tags', element: <TagSettings /> },
              { path: 'data', element: <DataSettings /> },
            ],
          },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
